// pulls sent Slack messages and 1:1 DM exchanges into data/recon/.
// run: pnpm recon:collect

import { mkdirSync, writeFileSync } from "node:fs";
import { WebClient } from "@slack/web-api";
import { required } from "../src/env.ts";
import { PAIRS_FILE, RAW_DIR, SENT_FILE, toJsonl, type DmPair, type SentMessage } from "./shared.ts";

const MAX_SEARCH_PAGES = 100; // Slack's search pagination limit
const TURN_GAP_SECONDS = 10 * 60; // same-speaker messages closer than this form one turn
const MAX_REPLY_DELAY_SECONDS = 6 * 60 * 60; // a reply later than this isn't treated as an answer

const web = new WebClient(required("SLACK_USER_TOKEN"));
const { user_id: selfId } = await web.auth.test();
if (!selfId) throw new Error("auth.test returned no user_id");

const names = new Map<string, string>();
async function nameOf(userId: string): Promise<string> {
  const cached = names.get(userId);
  if (cached) return cached;
  try {
    const { user } = await web.users.info({ user: userId });
    const name = user?.profile?.display_name || user?.real_name || user?.name || userId;
    names.set(userId, name);
    return name;
  } catch {
    names.set(userId, userId);
    return userId;
  }
}

// slack markup: <@U123>, <#C123|name>, <https://x|label>, <https://x>.
async function cleanText(text: string): Promise<string> {
  const mentionIds = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);
  for (const id of new Set(mentionIds)) await nameOf(id);
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

// --- 1. every message the user sent, via search ---
async function collectSent(): Promise<SentMessage[]> {
  const sent: SentMessage[] = [];
  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const res = await web.search.messages({ query: `from:<@${selfId}>`, sort: "timestamp", count: 100, page });
    const matches = res.messages?.matches ?? [];
    for (const match of matches) {
      if (!match.ts || !match.channel?.id || !match.text) continue;
      const channel = match.channel;
      sent.push({
        ts: match.ts,
        channelId: channel.id!,
        channelType: channel.is_im ? "im" : channel.is_mpim ? "mpim" : channel.is_private ? "group" : "channel",
        text: await cleanText(match.text),
      });
    }
    const pages = res.messages?.paging?.pages ?? 1;
    process.stdout.write(`\rsearch: page ${page}/${pages}, ${sent.length} messages`);
    if (page >= pages) break;
  }
  process.stdout.write("\n");
  return sent;
}

// --- 2. question -> reply pairs from 1:1 DMs ---
type Turn = { userId: string; ts: number; text: string };

async function dmHistory(channelId: string) {
  const messages: { user?: string; ts?: string; text?: string; subtype?: string; bot_id?: string }[] = [];
  let cursor: string | undefined;
  do {
    const res = await web.conversations.history({ channel: channelId, limit: 200, cursor });
    messages.push(...(res.messages ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages
    .filter((m) => m.user && m.ts && m.text && !m.subtype && !m.bot_id)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

// merge consecutive same-speaker messages into turns, then pair each other-person turn with
// the user's next turn if they answered within MAX_REPLY_DELAY_SECONDS.
async function pairsForDm(channelId: string, withUserId: string): Promise<DmPair[]> {
  const turns: Turn[] = [];
  for (const m of await dmHistory(channelId)) {
    const ts = Number(m.ts);
    const text = await cleanText(m.text!);
    const last = turns.at(-1);
    if (last && last.userId === m.user && ts - last.ts < TURN_GAP_SECONDS) {
      last.text += `\n${text}`;
      last.ts = ts;
    } else {
      turns.push({ userId: m.user!, ts, text });
    }
  }

  const withName = await nameOf(withUserId);
  const pairs: DmPair[] = [];
  for (let i = 1; i < turns.length; i++) {
    const question = turns[i - 1]!;
    const reply = turns[i]!;
    if (question.userId !== withUserId || reply.userId !== selfId) continue;
    if (reply.ts - question.ts > MAX_REPLY_DELAY_SECONDS) continue;
    pairs.push({
      id: `${channelId}:${reply.ts}`,
      withUserId,
      withName,
      ts: String(reply.ts),
      question: question.text,
      reply: reply.text,
    });
  }
  return pairs;
}

async function collectPairs(): Promise<DmPair[]> {
  const dms: { id: string; user: string }[] = [];
  let cursor: string | undefined;
  do {
    const res = await web.conversations.list({ types: "im", limit: 200, cursor });
    for (const channel of res.channels ?? []) {
      // skip the self-DM and Slackbot.
      if (channel.id && channel.user && channel.user !== selfId && channel.user !== "USLACKBOT") {
        dms.push({ id: channel.id, user: channel.user });
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const pairs: DmPair[] = [];
  for (const [i, dm] of dms.entries()) {
    pairs.push(...(await pairsForDm(dm.id, dm.user)));
    process.stdout.write(`\rdms: ${i + 1}/${dms.length}, ${pairs.length} pairs`);
  }
  process.stdout.write("\n");
  return pairs;
}

mkdirSync(RAW_DIR, { recursive: true });

const sent = await collectSent();
writeFileSync(SENT_FILE, toJsonl(sent));
console.log(`wrote ${sent.length} sent messages to ${SENT_FILE}`);

const pairs = await collectPairs();
writeFileSync(PAIRS_FILE, toJsonl(pairs));
console.log(`wrote ${pairs.length} DM pairs to ${PAIRS_FILE}`);
