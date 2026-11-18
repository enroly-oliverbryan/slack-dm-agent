import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.USER_NAME ??= "Sam";
const { agentReply, feedbackFor, isAgentMessage } = await import("./messages.ts");
const { AGENT_HEADER } = await import("./env.ts");

describe("agent messages", () => {
  it("open with a small header line, then the reply", () => {
    const { text, blocks } = agentReply("it's in bursts.ts");
    assert.equal(blocks[0].type, "context");
    assert.equal(blocks[1].type, "section");
    assert.equal(text, `${AGENT_HEADER}: it's in bursts.ts`);
  });

  it("name the teammate in the header when the reply goes to the user's self-DM", () => {
    const { text } = agentReply("hi", { forName: "Ana" });
    assert.equal(text, `${AGENT_HEADER} · reply to Ana: hi`);
  });

  it("split replies longer than a section allows", () => {
    assert.equal(agentReply("x".repeat(6500)).blocks.length, 4);
  });

  it("are told apart from the user's own messages", () => {
    assert.equal(isAgentMessage(agentReply("hi")), true);
    assert.equal(isAgentMessage({ blocks: [] }), false);
    assert.equal(isAgentMessage({}), false);
  });

  it("ask for feedback in a separate line, keeping block_ids unique", () => {
    const { blocks } = agentReply("hi", { askFeedback: true });
    assert.equal(blocks.at(-1)?.type, "context");
    const ids = blocks.map((b) => b.block_id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("read ✅ / ❌ style reactions as feedback", () => {
    assert.equal(feedbackFor("white_check_mark"), "good");
    assert.equal(feedbackFor("heavy_check_mark"), "good");
    assert.equal(feedbackFor("x"), "bad");
    assert.equal(feedbackFor("thumbsup"), undefined);
  });
});
