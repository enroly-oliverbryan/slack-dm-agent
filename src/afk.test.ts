import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.USER_NAME ??= "Sam";
const { AfkMode, awayNote, parseAfkCommand } = await import("./afk.ts");

// 13:00 local time
const NOW = new Date(2026, 10, 19, 13, 0);
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 19 + dayOffset, h, m);
const tempFile = () => join(mkdtempSync(join(tmpdir(), "afk-")), "afk.json");

describe("parseAfkCommand", () => {
  it("reads on and off", () => {
    assert.deepEqual(parseAfkCommand("afk", NOW), { on: true, until: undefined, reason: undefined });
    assert.deepEqual(parseAfkCommand("AFK lunch", NOW), { on: true, until: undefined, reason: "lunch" });
    assert.deepEqual(parseAfkCommand("back", NOW), { on: false });
    assert.deepEqual(parseAfkCommand("Back!", NOW), { on: false });
    assert.deepEqual(parseAfkCommand("afk off", NOW), { on: false });
  });

  it("ignores other messages", () => {
    assert.equal(parseAfkCommand("afkx", NOW), undefined);
    assert.equal(parseAfkCommand("back in 5", NOW), undefined);
    assert.equal(parseAfkCommand("going afk", NOW), undefined);
  });

  it("reads durations", () => {
    assert.deepEqual(parseAfkCommand("afk 45m", NOW), { on: true, until: at(13, 45), reason: undefined });
    assert.deepEqual(parseAfkCommand("afk 1h lunch", NOW), { on: true, until: at(14), reason: "lunch" });
    assert.deepEqual(parseAfkCommand("afk for 2 hours - dentist", NOW), { on: true, until: at(15), reason: "dentist" });
  });

  it("reads end times", () => {
    assert.deepEqual(parseAfkCommand("afk until 14:30 meeting", NOW), {
      on: true,
      until: at(14, 30),
      reason: "meeting",
    });
    const until = (text: string) => (parseAfkCommand(text, NOW) as { until?: Date }).until;
    assert.deepEqual(until("afk till 2pm"), at(14));
    assert.deepEqual(until("afk until 2"), at(14)); // no am/pm: the next 2 o'clock
    assert.deepEqual(until("afk until 9am"), at(9, 0, 1)); // already past today
    assert.deepEqual(until("afk until 12:30"), at(12, 30, 1));
  });
});

describe("AfkMode", () => {
  it("starts, ends and survives a restart", () => {
    const file = tempFile();
    const afk = new AfkMode(file, undefined, () => NOW);
    afk.start(at(14), "lunch");
    assert.equal(new AfkMode(file, undefined, () => NOW).current()?.reason, "lunch");
    assert.equal(afk.end()?.reason, "lunch");
    assert.equal(afk.current(), undefined);
    assert.equal(new AfkMode(file, undefined, () => NOW).current(), undefined);
  });

  it("ends on its own once the time is up", () => {
    let now = NOW;
    const expired: string[] = [];
    const afk = new AfkMode(
      tempFile(),
      (away) => expired.push(away.reason ?? ""),
      () => now,
    );
    afk.start(at(14), "lunch");
    now = at(13, 59);
    assert.ok(afk.current());
    now = at(14);
    assert.equal(afk.current(), undefined);
    assert.deepEqual(expired, ["lunch"]);
  });
});

describe("awayNote", () => {
  const away = { since: NOW.toISOString() };
  it("says why and when", () => {
    assert.equal(
      awayNote({ ...away, reason: "lunch", until: at(14).toISOString() }),
      "Sam is away (lunch), back around 14:00. I'll make sure Sam sees this.",
    );
    assert.equal(awayNote(away, { urgent: true }), "Sam is away. I've flagged this to Sam as urgent.");
  });
});
