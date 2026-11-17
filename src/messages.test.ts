import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.USER_NAME ??= "Sam";
const { agentReply, isAgentMessage } = await import("./messages.ts");
const { AGENT_HEADER } = await import("./env.ts");

describe("agent messages", () => {
  it("open with a small header line, then the reply", () => {
    const { text, blocks } = agentReply("it's in bursts.ts");
    assert.equal(blocks[0].type, "context");
    assert.equal(blocks[1].type, "section");
    assert.equal(text, `${AGENT_HEADER}: it's in bursts.ts`);
  });

  it("split replies longer than a section allows", () => {
    assert.equal(agentReply("x".repeat(6500)).blocks.length, 4);
  });

  it("are told apart from the user's own messages", () => {
    assert.equal(isAgentMessage(agentReply("hi")), true);
    assert.equal(isAgentMessage({ blocks: [] }), false);
    assert.equal(isAgentMessage({}), false);
  });
});
