import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.USER_NAME ??= "Sam";
const { agentReply, isAgentMessage, looksLikeAgentMessage } = await import("./messages.ts");
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

  it("are recognised by their header text when blocks are missing", () => {
    assert.equal(looksLikeAgentMessage({ text: agentReply("hi").text }), true);
    assert.equal(looksLikeAgentMessage({ text: "hi from me" }), false);
  });
});
