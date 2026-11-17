import { execFile } from "node:child_process";
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
import { recordBurst, type AuditRecord } from "./audit.ts";

const { allowlist, debounceSeconds, recentReplySeconds, skipWhenActive } = config;

const web = new WebClient(required("SLACK_USER_TOKEN"));
const socket = new SocketModeClient({ appToken: required("SLACK_APP_TOKEN") });

const { user_id: selfId } = await web.auth.test();
if (!selfId) throw new Error("auth.test returned no user_id");
console.log(`Authenticated as ${selfId}. Watching DMs from: ${[...allowlist.values()].join(", ")}`);
console.log(
  `Debounce ${debounceSeconds}s, recent reply window ${recentReplySeconds}s, skip when active: ${skipWhenActive}`,
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
if (selfDm) console.log(`Test mode: send "T: <message>" to yourself in Slack (${selfDm}).`);
else console.warn("No self-DM found, test messages are off. Open your own DM in Slack once and restart.");

const seen = new Set<string>();

function notify(title: string, body: string, loud = false) {
  // AppleScript string literal: escape backslashes and quotes.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sound = loud ? ' sound name "Sosumi"' : "";
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"${sound}`]);
}

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
      .filter((m) => !m.subtype && m.text)
      .reverse()
      .map((m) => {
        const text = m.text ?? "";
        if (m.user !== selfId) return { from: sender, text };
        if (isAgentMessage(m)) return { from: `${USER_NAME}'s agent`, text };
        // in the self-DM, "T:" lines are the test teammate's side of the conversation.
        if (burst.channel === selfDm && TEST_PREFIX.test(text))
          return { from: sender, text: text.replace(TEST_PREFIX, "") };
        return { from: USER_NAME, text };
      });
  } catch (error) {
    console.warn("conversations.history failed, triaging without context:", error);
    return [];
  }
}

async function userIsActive(): Promise<boolean> {
  try {
    const { presence } = await web.users.getPresence({ user: selfId });
    return presence === "active";
  } catch (error) {
    // presence is a soft signal: if Slack won't say, carry on as if away.
    console.warn("users.getPresence failed:", error);
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
    if (id) console.log(`[${burst.channel}] logged as #${id} (pnpm audit-log ${id})`);
  }
}

async function processBurst(burst: Burst, audit: AuditRecord) {
  const name = audit.senderName;
  const messages = audit.messages;
  const text = messages.join("\n");

  if (skipWhenActive && (await userIsActive())) {
    console.log(`[${burst.channel}] skipped ${messages.length} message(s) from ${name}: you're active`);
    audit.outcome = "skipped-active";
    return;
  }
  console.log(`[${burst.channel}] burst from ${name} (${messages.length} message(s)) ready:\n${text}`);

  const history = await recentHistory(burst);
  let result;
  try {
    result = await triage({ sender: name, history: history.slice(-10), messages });
  } catch (error) {
    // never lose a message to a triage failure: tell the user and stop there.
    console.error("triage failed:", error);
    notify(`DM from ${name} (triage failed)`, text);
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
  console.log(
    `[${burst.channel}] triage: ${result.action}${result.urgent ? " (urgent)" : ""} - ${result.reason}` +
      (result.topics.length ? `\n  topics: ${result.topics.join(", ")}` : "") +
      (refs.length ? `\n  refs: ${refs.join(", ")}` : "") +
      `\n  cost: $${result.costUsd.toFixed(4)}`,
  );

  if (result.action === "ignore" && !result.urgent) {
    audit.outcome = "ignored";
    return;
  }

  // requests, decisions, incidents and personal messages are for the user to answer: the agent stays quiet.
  if (result.action !== "answer") {
    console.log(`[${burst.channel}] left for you, no reply sent`);
    notify(`${name} needs you${result.urgent ? " (URGENT)" : ""}`, text, true);
    audit.outcome = "deferred";
    return;
  }

  console.log(`[${burst.channel}] researching a reply...`);
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
    });
  } catch (error) {
    console.error("responder failed:", error);
    Object.assign(audit, { outcome: "responder-failed", error: (error as Error).message });
    await send(audit, burst, holdingReply(), { holding: true });
    notify(`${name} needs you (responder failed)`, text, true);
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
  const holdBack = draft.needsUser
    ? "needs you"
    : draft.confidence < config.confidenceThreshold
      ? `confidence ${draft.confidence.toFixed(2)}`
      : secret
        ? `draft looked like it held a ${secret}`
        : undefined;
  console.log(
    `[${burst.channel}] draft: confidence ${draft.confidence.toFixed(2)}${draft.needsUser ? ", needs you" : ""} · ` +
      `${(draft.durationMs / 1000).toFixed(0)}s · $${draft.costUsd.toFixed(3)} · ${draft.toolCalls.join(", ") || "no tools"}` +
      `\n  reasoning: ${draft.reasoning}` +
      (draft.sources.length ? `\n  sources: ${draft.sources.join(", ")}` : "") +
      (draft.t3Problem ? `\n  T3 unavailable (${draft.t3Problem}): re-approve t3-code via /mcp in Claude Code` : "") +
      `\n${draft.reply}`,
  );

  if (holdBack) {
    console.log(`[${burst.channel}] sending a holding reply instead: ${holdBack}`);
    Object.assign(audit, { outcome: "held-back", holdReason: holdBack });
    await send(audit, burst, holdingReply(), { holding: true });
    notify(`${name} needs you (${holdBack})`, text, true);
    return;
  }
  audit.outcome = "answered";
  const sent = await send(audit, burst, draft.reply);
  notify(sent === "teammate" ? `Replied to ${name}` : `Drafted a reply to ${name}`, draft.reply);
}

// reply() plus the audit record of what went where.
async function send(audit: AuditRecord, burst: Burst, text: string, options?: { holding?: boolean }) {
  const sentTo = await reply(burst, audit.senderName, text, options);
  audit.sentTo = sentTo;
  if (sentTo !== "skipped") audit.sentText = text;
  return sentTo;
}

// replies in the DM the burst came from when it's a test message or sending to this teammate is on. Otherwise the
// reply goes to the user's self-DM, naming the teammate, and holding replies are skipped.
async function reply(
  burst: Burst,
  name: string,
  text: string,
  { holding = false } = {},
): Promise<"teammate" | "self-dm" | "skipped"> {
  const direct = burst.channel === selfDm || config.sendsTo(burst.user);
  if (!direct && (holding || !selfDm)) {
    console.log(`[${burst.channel}] not sending to ${name}${holding ? " (holding reply)" : ""}`);
    return "skipped";
  }
  const channel = direct ? burst.channel : selfDm!;
  try {
    await web.chat.postMessage({ channel, ...agentReply(text, direct ? undefined : name), unfurl_links: false });
    console.log(`[${burst.channel}] sent to ${direct ? name : "your self-DM"}`);
    return direct ? "teammate" : "self-dm";
  } catch (error) {
    console.error("sending the reply failed:", error);
    notify("Agent reply failed to send", text, true);
    return "skipped";
  }
}

const bursts = new BurstTracker({
  quietMs: debounceSeconds * 1000,
  recentReplyMs: recentReplySeconds * 1000,
  onReady: (burst) => void handleBurst(burst).catch((error) => console.error("handleBurst failed:", error)),
});

socket.on("message", async ({ event, ack }) => {
  await ack();

  // only plain new messages in 1:1 DMs. Subtypes cover edits, deletes, joins, bot posts.
  if (event.channel_type !== "im" || event.subtype || event.bot_id) return;

  const key = `${event.channel}:${event.ts}`;
  if (seen.has(key)) return;
  seen.add(key);

  // the agent's own posts come from the user's account; they aren't the user replying.
  if (event.user === selfId && isAgentMessage(event)) return;

  if (event.user === selfId && event.channel === selfDm && TEST_PREFIX.test(event.text ?? "")) {
    const text = (event.text ?? "").replace(TEST_PREFIX, "");
    const result = bursts.add(event.channel, TEST_SENDER, { ts: event.ts, text });
    console.log(
      `[${event.channel}] test: ${text}${result === "user-here" ? "  (you replied recently, leaving it)" : ""}`,
    );
    return;
  }

  if (event.user === selfId) {
    const cancelled = bursts.selfPosted(event.channel, event.ts);
    const hint = event.channel === selfDm ? '  (counts as your reply; start with "T:" to send a test message)' : "";
    console.log(`[${event.channel}] you: ${event.text}${hint}`);
    if (cancelled)
      console.log(`[${event.channel}] you replied, dropped ${cancelled.messages.length} pending message(s)`);
    return;
  }

  const name = allowlist.get(event.user);
  if (!name) return;

  const result = bursts.add(event.channel, event.user, { ts: event.ts, text: event.text ?? "" });
  console.log(
    `[${event.channel}] ${name}: ${event.text}${result === "user-here" ? "  (you replied recently, leaving it)" : ""}`,
  );
});

socket.on("connected", () => console.log("Socket connected, listening for DMs."));
socket.on("disconnected", () => console.warn("Socket disconnected, reconnecting..."));

await socket.start();
