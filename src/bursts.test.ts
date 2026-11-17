import { beforeEach, afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { BurstTracker, type Burst } from "./bursts.ts";

const QUIET = 45_000;
const RECENT = 300_000;

describe("BurstTracker", () => {
  let ready: Burst[];
  let tracker: BurstTracker;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    ready = [];
    tracker = new BurstTracker({ quietMs: QUIET, recentReplyMs: RECENT, onReady: (b) => ready.push(b) });
  });
  afterEach(() => mock.timers.reset());

  it("releases a burst after the quiet period", () => {
    tracker.add("D1", "U1", { ts: "1000.000100", text: "hey" });
    mock.timers.tick(QUIET - 1);
    assert.equal(ready.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(
      ready.map((b) => b.messages.map((m) => m.text)),
      [["hey"]],
    );
  });

  it("groups messages and restarts the quiet period on each one", () => {
    tracker.add("D1", "U1", { ts: "1000.000100", text: "hey" });
    mock.timers.tick(30_000);
    tracker.add("D1", "U1", { ts: "1030.000100", text: "quick q" });
    mock.timers.tick(30_000);
    assert.equal(ready.length, 0);
    mock.timers.tick(15_000);
    assert.deepEqual(
      ready[0].messages.map((m) => m.text),
      ["hey", "quick q"],
    );
  });

  it("keeps DMs from different people apart", () => {
    tracker.add("D1", "U1", { ts: "1000.000100", text: "a" });
    tracker.add("D2", "U2", { ts: "1000.000200", text: "b" });
    mock.timers.tick(QUIET);
    assert.deepEqual(ready.map((b) => b.channel).sort(), ["D1", "D2"]);
  });

  it("cancels a pending burst when the user posts in the DM", () => {
    tracker.add("D1", "U1", { ts: "1000.000100", text: "hey" });
    const cancelled = tracker.selfPosted("D1", "1010.000100");
    assert.equal(cancelled?.messages.length, 1);
    mock.timers.tick(QUIET);
    assert.equal(ready.length, 0);
  });

  it("does not cancel a burst in another DM", () => {
    tracker.add("D1", "U1", { ts: "1000.000100", text: "hey" });
    assert.equal(tracker.selfPosted("D2", "1010.000100"), undefined);
    mock.timers.tick(QUIET);
    assert.equal(ready.length, 1);
  });

  it("skips messages that arrive soon after the user's own message", () => {
    tracker.selfPosted("D1", "1000.000100");
    assert.equal(tracker.add("D1", "U1", { ts: "1100.000100", text: "thanks" }), "user-here");
    mock.timers.tick(QUIET);
    assert.equal(ready.length, 0);
  });

  it("handles messages once the user has been quiet long enough", () => {
    tracker.selfPosted("D1", "1000.000100");
    assert.equal(tracker.add("D1", "U1", { ts: "1300.000100", text: "you there?" }), "pending");
    mock.timers.tick(QUIET);
    assert.equal(ready.length, 1);
  });
});
