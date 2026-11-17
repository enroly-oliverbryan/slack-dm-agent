import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { USER_NAME } from "../src/env.ts";

export { USER_NAME };

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

// raw Slack data
export const RAW_DIR = root("data/recon");
export const SENT_FILE = root("data/recon/sent.jsonl");
export const PAIRS_FILE = root("data/recon/dm-pairs.jsonl");

// generated tone profile
export const PROFILE_DIR = root("profile");

export const MODEL = "claude-opus-5-5";

// Who reads the profile. The agent borrows the user's tone; it never poses as them.
// Prompts refer to the user by name and as "they", so nothing assumes pronouns.
export const AGENT_FRAMING = `The profile is read by ${USER_NAME}'s agent: an assistant that replies to teammates' Slack DMs while ${USER_NAME} is busy.
The agent speaks as itself, not as ${USER_NAME}:
- "I" is the agent. ${USER_NAME} is "${USER_NAME}", in the third person.
- It borrows ${USER_NAME}'s tone, vocabulary, message length, punctuation and emoji habits, so replies feel familiar.
- It never claims to be ${USER_NAME}, and never states ${USER_NAME}'s opinions, decisions or commitments as its own.
- It can only answer from information it has found. Anything that needs ${USER_NAME} (looking into something, deciding, agreeing to work) is handed back: "${USER_NAME} will get back to you".
${USER_NAME}'s own messages below are first-person. Treat them as evidence of their tone, not as lines the agent can say verbatim.
Refer to ${USER_NAME} by name, or as "they" if a pronoun is needed.`;
const MAX_CHARS_PER_MESSAGE = 600; // long pastes (logs, code) say little about voice

export type SentMessage = {
  ts: string;
  channelId: string;
  channelType: "im" | "mpim" | "channel" | "group";
  text: string;
};

// one exchange in a DM
export type DmPair = {
  id: string;
  withUserId: string;
  withName: string;
  ts: string;
  question: string;
  reply: string;
};

export const toJsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) throw new Error(`${file} not found. Run pnpm recon:collect first.`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export const clip = (text: string) =>
  text.length > MAX_CHARS_PER_MESSAGE ? `${text.slice(0, MAX_CHARS_PER_MESSAGE)} [...truncated]` : text;

export const formatPair = (p: DmPair) => `<pair id="${p.id}" with="${p.withName}" with_id="${p.withUserId}">
<them>${clip(p.question)}</them>
<user>${clip(p.reply)}</user>
</pair>`;

// One-shot structured generation with Opus 5.5 on the Claude Code login (no API key needed).
export async function generate<T>(opts: {
  systemPrompt: string;
  prompt: string;
  schema: Record<string, unknown>;
}): Promise<{ output: T; costUsd: number }> {
  for await (const message of query({
    prompt: opts.prompt,
    options: {
      model: MODEL,
      effort: "high",
      systemPrompt: opts.systemPrompt,
      tools: [], // pure generation: no file, shell or web access
      settingSources: [], // don't load CLAUDE.md or user settings into this run
      persistSession: false,
      outputFormat: { type: "json_schema", schema: opts.schema },
    },
  })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(`generation failed: ${message.subtype}`);
    return { output: message.structured_output as T, costUsd: message.total_cost_usd };
  }
  throw new Error("no result returned");
}
