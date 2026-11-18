// how agent messages look in Slack.
//
// Messages post from the user's account, so each one opens with a small grey "From <name>'s agent" line (a Block Kit
// context block). Its block_id is how the watcher tells agent posts from the user's own messages.

import type { KnownBlock } from "@slack/web-api";
import { AGENT_HEADER, USER_NAME } from "./env.ts";

const REPLY_ID = "dm-agent-reply";
const SECTION_LIMIT = 3000; // Slack's cap on a section block's text

export const isAgentMessage = (message: { blocks?: { block_id?: string }[] }) =>
  !!message.blocks?.some((b) => b.block_id === REPLY_ID);

// block_ids must be unique within a message: only the header line carries REPLY_ID.
const small = (text: string, blockId?: string): KnownBlock => ({
  type: "context",
  ...(blockId ? { block_id: blockId } : {}),
  elements: [{ type: "mrkdwn", text }],
});

const sections = (text: string): KnownBlock[] => {
  const blocks: KnownBlock[] = [];
  for (let at = 0; at < text.length; at += SECTION_LIMIT)
    blocks.push({ type: "section", text: { type: "mrkdwn", text: text.slice(at, at + SECTION_LIMIT) } });
  return blocks;
};

// the reactions the agent adds to its answers, for the recipient to mark them.
export const GOOD = "white_check_mark";
export const BAD = "x";
const GOOD_ALIASES = new Set([GOOD, "heavy_check_mark", "ballot_box_with_check"]);
const BAD_ALIASES = new Set([BAD, "heavy_multiplication_x", "negative_squared_cross_mark"]);
export const feedbackFor = (reaction: string): "good" | "bad" | undefined =>
  GOOD_ALIASES.has(reaction) ? "good" : BAD_ALIASES.has(reaction) ? "bad" : undefined;

// what a teammate sees. `text` is the plain fallback used in notifications.
// - forName: the header says who the reply was for, when it goes to the user's self-DM instead of the teammate.
// - askFeedback: a line under the reply asking the recipient to react ✅ or ❌.
export function agentReply(
  reply: string,
  { forName, askFeedback = false }: { forName?: string; askFeedback?: boolean } = {},
): { text: string; blocks: KnownBlock[] } {
  const header = forName ? `${AGENT_HEADER} · reply to ${forName}` : AGENT_HEADER;
  const blocks = [small(header, REPLY_ID), ...sections(reply)];
  if (askFeedback) blocks.push(small(`:${GOOD}: if this answered it, :${BAD}: if you still need ${USER_NAME}`));
  return { text: `${header}: ${reply}`, blocks };
}
