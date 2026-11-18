import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { burstById, burstByReply, recentBursts, recordBurst, setFeedback, useDatabase } from "./audit.ts";

describe("audit log", () => {
  useDatabase(":memory:");

  it("round-trips a burst, including arrays and booleans", () => {
    const id = recordBurst({
      at: "2026-11-17T18:00:00.000Z",
      channel: "D1",
      senderId: "U1",
      senderName: "Ana",
      test: false,
      messages: ["how does the debounce work?"],
      outcome: "answered",
      triageAction: "answer",
      triageUrgent: false,
      prs: [8841],
      draft: "It waits for 45s of quiet.",
      confidence: 0.9,
      needsUser: false,
      toolCalls: ["Read", "StructuredOutput"],
      sentText: "It waits for 45s of quiet.",
      sentTo: "self-dm",
      costUsd: 0.04,
      durationMs: 6000,
    });
    assert.ok(id);
    const row = burstById(id);
    assert.equal(row?.senderName, "Ana");
    assert.deepEqual(row?.messages, ["how does the debounce work?"]);
    assert.deepEqual(row?.prs, [8841]);
    assert.equal(row?.needsUser, false);
    assert.equal(row?.confidence, 0.9);
    assert.equal(row?.holdReason, undefined);
  });

  it("lists newest first", () => {
    recordBurst({
      at: "t",
      channel: "D2",
      senderId: "U2",
      senderName: "Ben",
      test: true,
      messages: ["hi"],
      costUsd: 0,
    });
    assert.equal(recentBursts(1)[0].senderName, "Ben");
  });

  it("finds a burst by its reply and records feedback", () => {
    const id = recordBurst({
      at: "t",
      channel: "D3",
      senderId: "U3",
      senderName: "Cat",
      test: false,
      messages: ["q"],
      replyChannel: "D3",
      replyTs: "1700000000.000100",
      costUsd: 0,
    });
    assert.equal(burstByReply("D3", "1700000000.000100")?.id, id);
    assert.equal(burstByReply("D3", "1700000000.000999"), undefined);
    setFeedback(id!, "bad");
    assert.equal(burstById(id!)?.feedback, "bad");
  });
});
