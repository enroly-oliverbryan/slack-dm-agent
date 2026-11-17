import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

const config: { allowlist: { id: string; name: string }[] } = JSON.parse(
  readFileSync(new URL("../config.json", import.meta.url), "utf8"),
);
const badIds = config.allowlist.filter((user) => !user.id.startsWith("U") && !user.id.startsWith("W"));
if (badIds.length) {
  throw new Error(
    `config.json allowlist needs user IDs (U...), not channel IDs: ${badIds.map((p) => p.id).join(", ")}`,
  );
}
const allowlist = new Map(config.allowlist.map((p) => [p.id, p.name]));

const web = new WebClient(required("SLACK_USER_TOKEN"));
const socket = new SocketModeClient({ appToken: required("SLACK_APP_TOKEN") });

const { user_id: selfId } = await web.auth.test();
console.log(`Authenticated as ${selfId}. Watching DMs from: ${[...allowlist.values()].join(", ")}`);

const seen = new Set<string>();

function notify(title: string, body: string) {
  // AppleScript string literal: escape backslashes and quotes.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`]);
}

socket.on("message", async ({ event, ack }) => {
  await ack();

  // only plain new messages in 1:1 DMs. Subtypes cover edits, deletes, joins, bot posts.
  if (event.channel_type !== "im" || event.subtype || event.bot_id) return;

  const key = `${event.channel}:${event.ts}`;
  if (seen.has(key)) return;
  seen.add(key);

  if (event.user === selfId) {
    console.log(`[${event.channel}] you: ${event.text}`);
    return;
  }

  const name = allowlist.get(event.user);
  if (!name) return;

  console.log(`[${event.channel}] ${name}: ${event.text}`);
  notify(`DM from ${name}`, event.text ?? "");
  // next: debounce, triage, respond.
});

socket.on("connected", () => console.log("Socket connected, listening for DMs."));
socket.on("disconnected", () => console.warn("Socket disconnected, reconnecting..."));

await socket.start();
