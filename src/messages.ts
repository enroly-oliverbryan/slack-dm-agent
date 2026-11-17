// how agent messages look in Slack.
//
// Messages post from the user's account, so each one opens with a small grey "From <name>'s agent" line (a Block Kit
// context block). Its block_id is how the watcher tells agent posts from the user's own messages.

import type { KnownBlock } from "@slack/web-api";
import { AGENT_HEADER } from "./env.ts";

const REPLY_ID = "dm-agent-reply";
const SECTION_LIMIT = 3000; // Slack's cap on a section block's text

export const isAgentMessage = (message: { blocks?: { block_id?: string }[] }) =>
  !!message.blocks?.some((b) => b.block_id === REPLY_ID);

const small = (text: string): KnownBlock => ({
  type: "context",
  block_id: REPLY_ID,
  elements: [{ type: "mrkdwn", text }],
});

const sections = (text: string): KnownBlock[] => {
  const blocks: KnownBlock[] = [];
  for (let at = 0; at < text.length; at += SECTION_LIMIT)
    blocks.push({ type: "section", text: { type: "mrkdwn", text: text.slice(at, at + SECTION_LIMIT) } });
  return blocks;
};

// what a teammate sees. `text` is the plain fallback used in notifications.
export function agentReply(reply: string): { text: string; blocks: KnownBlock[] } {
  return { text: `${AGENT_HEADER}: ${reply}`, blocks: [small(AGENT_HEADER), ...sections(reply)] };
}
