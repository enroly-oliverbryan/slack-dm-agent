import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { required, USER_NAME } from "./env.ts";
import { config } from "./config.ts";
import { BurstTracker, type Burst } from "./bursts.ts";
import { triage, type Line } from "./triage.ts";
import { respond, type Draft } from "./responder/agent.ts";
import { holdingReply } from "./profile.ts";
import { agentReply, isAgentMessage } from "./messages.ts";
import { findSecret } from "./guard.ts";
import { burstsSince, recordBurst, type AuditRecord, type AuditRow } from "./audit.ts";
import { notify, slackLink } from "./notify.ts";
import { fileName, readAttachments, type SlackFile } from "./files.ts";
import { log, short, VERBOSE } from "./log.ts";
import { AfkMode, awayNote, describeAway, parseAfkCommand, type AfkCommand, type Away } from "./afk.ts";

const { allowlist, debounceSeconds, recentReplySeconds, skipWhenActive } = config;

const userToken = required("SLACK_USER_TOKEN");
const web = new WebClient(userToken);
const socket = new SocketModeClient({ appToken: required("SLACK_APP_TOKEN") });

const { user_id: selfId, team_id: teamId } = await web.auth.test();
if (!selfId) throw new Error("auth.test returned no user_id");
log.debug(
  `authenticated as ${selfId}; debounce ${debounceSeconds}s, recent reply window ${recentReplySeconds}s, ` +
    `skip when active: ${skipWhenActive}`,
);

// messages you send to yourself starting with "T:" play the part of a teammate, so the whole flow can be tested
// without bothering anyone. Your other messages in the self-DM count as your replies.
const TEST_PREFIX = /^T:\s*/;
const TEST_SENDER = "test";
allowlist.set(TEST_SENDER, "Test (you)");

async function findSelfDm(): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const page = await web.conversations.list({ types: "im", limit: 1000, cursor });
    const self = page.channels?.find((c) => c.user === selfId);
    if (self?.id) return self.id;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return undefined;
}

const selfDm = await findSelfDm();
if (!selfDm) log.warn("no self-DM found, so test messages are off. Open your own DM in Slack once and restart");
log.info(
  `watching ${allowlist.size - 1} people${selfDm ? ' · test with "T: <message>" in your self-DM' : ""}` +
    `${VERBOSE ? "" : " · VERBOSE=1 for detail"}`,
);

// posts an agent message in the self-DM: AFK confirmations and summaries.
async function postToSelf(text: string) {
  if (!selfDm) return;
  try {
    await web.chat.postMessage({ channel: selfDm, ...agentReply(text), unfurl_links: false });
  } catch (error) {
    log.warn("couldn't post in your self-DM", error);
  }
}

const afk = new AfkMode(undefined, (away) => {
  log.info(`AFK mode ended (was ${describeAway(away)})`);
  void postToSelf(whileAway(away, "AFK mode ended."));
});
// checked every minute, so an AFK period with an end time ends (and its summary posts) on time.
setInterval(() => afk.current(), 60_000);
const away = afk.current();
if (away) log.info(`AFK mode is on: ${describeAway(away)} · say "back" in your self-DM to end it`);

function onAfkCommand(command: AfkCommand) {
  if (command.on) {
    const away = afk.start(command.until, command.reason);
    log.info(`AFK mode on: ${describeAway(away)}`);
    void postToSelf(
      `AFK mode on: ${describeAway(away)}. Teammates who DM you get an away note and whatever answers I can find ` +
        "(in this DM unless `send_to_teammate_afk` is on for them). Say `back` to end it.",
    );
    return;
  }
  const away = afk.end();
  if (!away) return void postToSelf("AFK mode wasn't on.");
  log.info("AFK mode off");
  void postToSelf(whileAway(away, "Welcome back."));
}

// what happened while the user was away, for the self-DM.
function whileAway(away: Away, heading: string): string {
  const rows = burstsSince(away.since).filter((row) => row.outcome !== "ignored");
  if (!rows.length) return `${heading} Nobody needed you while you were away.`;
  const outcome = (row: AuditRow) =>
    row.outcome === "answered"
      ? row.needsUser
        ? "sent what I found, needs you"
        : "answered"
      : row.outcome === "deferred" && row.triageUrgent
        ? "*needs you (urgent)*"
        : "needs you";
  const lines = rows.map((row) => {
    const first = row.messages.find((m) => m.trim()) ?? "[attachment]";
    return `• ${row.senderName}: "${short(first)}" → ${outcome(row)} (#${row.id})`;
  });
  return `${heading} While you were away:\n${lines.join("\n")}`;
}

const seen = new Set<string>();

const HISTORY_LINES = 20; // the responder gets all of these, triage the last 10

// the messages before a burst, oldest first, so triage can tell "thanks" after an answer from a new question.
async function recentHistory(burst: Burst): Promise<Line[]> {
  try {
    const { messages = [] } = await web.conversations.history({
      channel: burst.channel,
      latest: burst.messages[0].ts,
      inclusive: false,
      limit: HISTORY_LINES,
    });
    const sender = allowlist.get(burst.user) ?? "Teammate";
    return messages
      .filter((m) => (!m.subtype || m.subtype === "file_share") && (m.text || m.files?.length))
      .reverse()
      .map((m) => {
        const files = (m.files as SlackFile[] | undefined)?.map(fileName);
        const text = `${m.text ?? ""}${files?.length ? ` [attached: ${files.join(", ")}]` : ""}`;
        if (m.user !== selfId) return { from: sender, text };
        if (isAgentMessage(m)) return { from: `${USER_NAME}'s agent`, text };
        // in the self-DM, "T:" lines are the test teammate's side of the conversation.
        if (burst.channel === selfDm && TEST_PREFIX.test(text))
          return { from: sender, text: text.replace(TEST_PREFIX, "") };
        return { from: USER_NAME, text };
      });
  } catch (error) {
    log.warn("couldn't read the DM history, triaging without it", error);
    return [];
  }
}

async function userIsActive(): Promise<boolean> {
  try {
    const { presence } = await web.users.getPresence({ user: selfId });
    return presence === "active";
  } catch (error) {
    // presence is a soft signal: if Slack won't say, carry on as if away.
    log.warnOnce("presence", "couldn't read your Slack presence", error);
    return false;
  }
}

async function handleBurst(burst: Burst) {
  const started = Date.now();
  const audit: AuditRecord = {
    at: new Date().toISOString(),
    channel: burst.channel,
    senderId: burst.user,
    senderName: allowlist.get(burst.user) ?? burst.user,
    test: burst.channel === selfDm,
    messages: burst.messages.map((m) => m.text),
    files: burst.messages.flatMap((m) => m.files ?? []).map(fileName),
    costUsd: 0,
  };
  try {
    await processBurst(burst, audit);
  } catch (error) {
    audit.error ??= (error as Error).message;
    throw error;
  } finally {
    audit.durationMs = Date.now() - started;
    const id = recordBurst(audit);
    log.info(summary(audit, id));
  }
}

// one line per burst: who, what, what happened. `pnpm audit-log <id>` has the rest.
function summary(audit: AuditRecord, id: number | undefined): string {
  const first = audit.messages.find((m) => m.trim()) ?? (audit.files?.length ? `[${audit.files.join(", ")}]` : "");
  const more = audit.messages.length > 1 ? ` (+${audit.messages.length - 1})` : "";
  const secs = `${Math.round((audit.durationMs ?? 0) / 1000)}s`;
  const cost = `$${audit.costUsd.toFixed(2)}`;
  const note = audit.sentTo === "self-dm" ? "away note drafted to your self-DM" : "away note sent";
  const outcome = (() => {
    switch (audit.outcome) {
      case "answered":
        return `${audit.sentTo === "self-dm" ? "drafted to your self-DM" : audit.needsUser ? "answered in part" : "answered"} (${audit.confidence?.toFixed(2)} · ${secs} · ${cost})`;
      case "held-back":
        return `held back: ${audit.holdReason} (${!audit.sentTo || audit.sentTo === "skipped" ? "nothing sent" : audit.afk ? note : "holding reply sent"} · ${cost})`;
      case "deferred":
        return `left for you${audit.triageUrgent ? " (urgent)" : ""}${audit.sentTo && audit.sentTo !== "skipped" ? `, ${note}` : ""}`;
      case "ignored":
        return "ignored";
      case "skipped-active":
        return "skipped, you're active";
      default:
        return `${audit.outcome ?? "failed"}${audit.error ? `: ${short(audit.error, 80)}` : ""}`;
    }
  })();
  return `${audit.senderName} "${short(first)}"${more} → ${outcome}${id ? ` #${id}` : ""}`;
}

async function processBurst(burst: Burst, audit: AuditRecord) {
  const name = audit.senderName;
  const messages = audit.messages;
  const text = messages.join("\n");
  const open = slackLink(teamId, burst.channel); // clicking a notification opens the DM

  // while AFK, Slack may still show the user as active (a laptop left open), so presence is ignored.
  const away = afk.current();
  audit.afk = !!away;
  if (skipWhenActive && !away && (await userIsActive())) {
    log.debug(`${name}: skipped, you're active`);
    audit.outcome = "skipped-active";
    return;
  }
  log.debug(`${name}: handling ${messages.length} message(s)`);

  const history = await recentHistory(burst);
  const files = burst.messages.flatMap((m) => m.files ?? []);
  const attachments = files.length ? await readAttachments(files, userToken) : undefined;
  if (attachments?.skipped.length)
    log.warn(`${name}: couldn't read ${attachments.skipped.map((f) => `${f.name} (${f.why})`).join(", ")}`);
  let result;
  try {
    result = await triage({ sender: name, history: history.slice(-10), messages, attachments });
  } catch (error) {
    // never lose a message to a triage failure: tell the user and stop there.
    log.debug(`triage failed: ${(error as Error).stack ?? error}`);
    notify(`DM from ${name} (triage failed)`, text, { open });
    Object.assign(audit, { outcome: "triage-failed", error: (error as Error).message });
    return;
  }
  Object.assign(audit, {
    triageAction: result.action,
    triageUrgent: result.urgent,
    triageReason: result.reason,
    topics: result.topics,
    prs: result.prs,
    jiraKeys: result.jiraKeys,
    costUsd: result.costUsd,
  });

  const refs = [...result.prs.map((n) => `#${n}`), ...result.jiraKeys];
  log.debug(
    `${name}: triage ${result.action}${result.urgent ? " (urgent)" : ""} - ${result.reason}` +
      (result.topics.length ? `\n  topics: ${result.topics.join(", ")}` : "") +
      (refs.length ? `\n  refs: ${refs.join(", ")}` : "") +
      `\n  cost: $${result.costUsd.toFixed(4)}`,
  );

  if (result.action === "ignore" && !result.urgent) {
    audit.outcome = "ignored";
    return;
  }

  // requests, decisions, incidents and personal messages are for the user to answer: the agent stays quiet. While
  // AFK they go to the responder too, which gives what context it can and leaves the decision to the user.
  if (result.action !== "answer" && !away) {
    log.debug(`${name}: left for you, no reply sent`);
    notify(`${name} needs you${result.urgent ? " (URGENT)" : ""}`, text, { loud: true, open });
    audit.outcome = "deferred";
    return;
  }

  // an urgent message gets the away note now, not after the research.
  if (away && result.urgent) {
    notify(`${name} needs you (URGENT)`, text, { loud: true, open });
    await tellAway(audit, burst, away, true);
  }

  log.debug(`${name}: researching a reply...`);
  let draft: Draft;
  try {
    draft = await respond({
      senderId: burst.user,
      senderName: name,
      messages,
      history,
      topics: result.topics,
      prs: result.prs,
      jiraKeys: result.jiraKeys,
      attachments,
      away: away && { description: describeAway(away), mentioned: result.urgent },
    });
  } catch (error) {
    log.debug(`responder failed: ${(error as Error).stack ?? error}`);
    Object.assign(audit, { outcome: "responder-failed", error: (error as Error).message });
    if (away && !result.urgent) await tellAway(audit, burst, away);
    else if (!away) await send(audit, burst, holdingReply(), { holding: true });
    notify(`${name} needs you (responder failed)`, text, { loud: true, open });
    return;
  }
  Object.assign(audit, {
    draft: draft.reply,
    confidence: draft.confidence,
    needsUser: draft.needsUser,
    sources: draft.sources,
    reasoning: draft.reasoning,
    toolCalls: draft.toolCalls,
    t3Problem: draft.t3Problem,
    costUsd: audit.costUsd + draft.costUsd,
  });

  const secret = findSecret(draft.reply);
  // while AFK, a reply that gives context but leaves the decision to the user is still sent.
  const holdBack =
    draft.needsUser && !away
      ? "needs you"
      : draft.confidence < config.confidenceThreshold
        ? `confidence ${draft.confidence.toFixed(2)}`
        : secret
          ? `draft looked like it held a ${secret}`
          : undefined;
  if (draft.t3Problem)
    log.warnOnce(
      `t3:${draft.t3Problem}`,
      `T3 unavailable (${draft.t3Problem}): re-approve t3-code via /mcp in Claude Code`,
    );
  log.debug(
    `${name}: draft, confidence ${draft.confidence.toFixed(2)}${draft.needsUser ? ", needs you" : ""} · ` +
      `${(draft.durationMs / 1000).toFixed(0)}s · $${draft.costUsd.toFixed(3)} · ${draft.toolCalls.join(", ") || "no tools"}` +
      `\n  reasoning: ${draft.reasoning}` +
      (draft.sources.length ? `\n  sources: ${draft.sources.join(", ")}` : "") +
      `\n${draft.reply}`,
  );

  if (holdBack) {
    log.debug(`${name}: holding back (${holdBack})`);
    Object.assign(audit, { outcome: "held-back", holdReason: holdBack });
    if (away && !result.urgent) await tellAway(audit, burst, away);
    else if (!away) await send(audit, burst, holdingReply(), { holding: true });
    notify(`${name} needs you (${holdBack})`, text, { loud: true, open });
    return;
  }
  audit.outcome = "answered";
  const sent = await send(audit, burst, draft.reply);
  if (draft.needsUser) {
    notify(`${name} needs you (sent what I found)`, text, { loud: true, open });
    return;
  }
  notify(sent === "teammate" ? `Replied to ${name}` : `Drafted a reply to ${name}`, draft.reply, { open });
}

// while AFK, every burst the agent can't answer gets the away note.
async function tellAway(audit: AuditRecord, burst: Burst, away: Away, urgent = false) {
  await send(audit, burst, awayNote(away, { urgent }), { holding: true });
}

// reply() plus the audit record of what went where.
async function send(audit: AuditRecord, burst: Burst, text: string, options?: { holding?: boolean }) {
  const sent = await reply(burst, audit.senderName, text, options);
  audit.sentTo = sent.to;
  if (sent.to !== "skipped") Object.assign(audit, { sentText: text, replyChannel: sent.channel, replyTs: sent.ts });
  return sent.to;
}

// replies in the DM the burst came from when it's a test message or sending to this teammate is on
// (send_to_teammate_afk while the user is AFK). Otherwise the
// reply goes to the user's self-DM, naming the teammate, and holding replies are skipped (away notes aren't, so AFK
// mode can be tried out in the self-DM).
async function reply(
  burst: Burst,
  name: string,
  text: string,
  { holding = false } = {},
): Promise<{ to: "teammate" | "self-dm" | "skipped"; channel?: string; ts?: string }> {
  const away = !!afk.current();
  const direct = burst.channel === selfDm || config.sendsTo(burst.user, away);
  if (!direct && ((holding && !away) || !selfDm)) {
    log.debug(`${name}: not sending${holding ? " a holding reply" : ""}`);
    return { to: "skipped" };
  }
  const channel = direct ? burst.channel : selfDm!;
  try {
    const message = agentReply(text, { forName: direct ? undefined : name });
    const { ts } = await web.chat.postMessage({ channel, ...message, unfurl_links: false });
    log.debug(`${name}: sent to ${direct ? name : "your self-DM"}`);
    return { to: direct ? "teammate" : "self-dm", channel, ts };
  } catch (error) {
    log.error(`couldn't send the reply to ${name}`, error);
    notify("Agent reply failed to send", text, { loud: true });
    return { to: "skipped" };
  }
}

const bursts = new BurstTracker({
  quietMs: debounceSeconds * 1000,
  recentReplyMs: recentReplySeconds * 1000,
  onReady: (burst) => void handleBurst(burst).catch((error) => log.error("handling a burst failed", error)),
  away: () => !!afk.current(),
});

socket.on("message", async ({ event, ack }) => {
  await ack();

  // only new messages in 1:1 DMs, plain or with files. Other subtypes cover edits, deletes, joins, bot posts.
  if (event.channel_type !== "im" || (event.subtype && event.subtype !== "file_share") || event.bot_id) return;
  const files: SlackFile[] | undefined = event.files?.length ? event.files : undefined;

  const key = `${event.channel}:${event.ts}`;
  if (seen.has(key)) return;
  seen.add(key);

  // the agent's own posts come from the user's account; they aren't the user replying.
  if (event.user === selfId && isAgentMessage(event)) return;

  // "afk ..." and "back" in the self-DM switch AFK mode. They aren't replies, so they don't cancel anything.
  const command = event.user === selfId && event.channel === selfDm ? parseAfkCommand(event.text ?? "") : undefined;
  if (command) return onAfkCommand(command);

  if (event.user === selfId && event.channel === selfDm && TEST_PREFIX.test(event.text ?? "")) {
    const text = (event.text ?? "").replace(TEST_PREFIX, "");
    const result = bursts.add(event.channel, TEST_SENDER, { ts: event.ts, text, files });
    log.debug(`test: ${short(text)}${result === "user-here" ? " (you replied recently, leaving it)" : ""}`);
    return;
  }

  if (event.user === selfId) {
    const cancelled = bursts.selfPosted(event.channel, event.ts);
    const hint = event.channel === selfDm ? ' (counts as your reply; start with "T:" to send a test message)' : "";
    log.debug(`you: ${short(event.text ?? "")}${hint}`);
    if (cancelled) log.debug(`you replied, dropped ${cancelled.messages.length} pending message(s)`);
    return;
  }

  const name = allowlist.get(event.user);
  if (!name) return;

  const result = bursts.add(event.channel, event.user, { ts: event.ts, text: event.text ?? "", files });
  log.debug(
    `${name}: ${short(event.text ?? "")}${result === "user-here" ? " (you replied recently, leaving it)" : ""}`,
  );
});

socket.on("connected", () => log.debug("socket connected"));
socket.on("disconnected", () => log.warn("Slack connection dropped, reconnecting"));

await socket.start();
