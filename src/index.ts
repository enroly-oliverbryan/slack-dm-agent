import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { required } from "./env.ts";
import { BurstTracker, type Burst } from "./bursts.ts";

type Config = {
  allowlist: { id: string; name: string }[];
  // quiet time after a teammate's last message before the burst is handled.
  debounce_seconds?: number;
  // a teammate message this soon after the user's own message in the DM is left to the user.
  recent_reply_seconds?: number;
  // skip bursts while the user's Slack presence is "active".
  skip_when_active?: boolean;
};

const config: Config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const badIds = config.allowlist.filter((user) => !user.id.startsWith("U") && !user.id.startsWith("W"));
if (badIds.length) {
  throw new Error(
    `config.json allowlist needs user IDs (U...), not channel IDs: ${badIds.map((p) => p.id).join(", ")}`,
  );
}
const allowlist = new Map(config.allowlist.map((p) => [p.id, p.name]));
const debounceSeconds = config.debounce_seconds ?? 45;
const recentReplySeconds = config.recent_reply_seconds ?? 300;
const skipWhenActive = config.skip_when_active ?? false;

const web = new WebClient(required("SLACK_USER_TOKEN"));
const socket = new SocketModeClient({ appToken: required("SLACK_APP_TOKEN") });

const { user_id: selfId } = await web.auth.test();
if (!selfId) throw new Error("auth.test returned no user_id");
console.log(`Authenticated as ${selfId}. Watching DMs from: ${[...allowlist.values()].join(", ")}`);
console.log(
  `Debounce ${debounceSeconds}s, recent reply window ${recentReplySeconds}s, skip when active: ${skipWhenActive}`,
);

const seen = new Set<string>();

function notify(title: string, body: string) {
  // AppleScript string literal: escape backslashes and quotes.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`]);
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
  const name = allowlist.get(burst.user) ?? burst.user;
  const count = burst.messages.length;

  if (skipWhenActive && (await userIsActive())) {
    console.log(`[${burst.channel}] skipped ${count} message(s) from ${name}: you're active`);
    return;
  }

  const text = burst.messages.map((m) => m.text).join("\n");
  console.log(`[${burst.channel}] burst from ${name} (${count} message(s)) ready:\n${text}`);
  notify(`DM from ${name}`, text);
  // next: triage, respond.
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

  if (event.user === selfId) {
    const cancelled = bursts.selfPosted(event.channel, event.ts);
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
