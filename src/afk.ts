// AFK mode: the user is away (lunch, a meeting), so the agent tells teammates and helps where it can.
// Switched on and off from the self-DM: "afk", "afk 1h lunch", "afk until 2pm", "back". Kept in data/afk.json, so a
// restart doesn't end it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_NAME } from "./env.ts";

export const AFK_FILE = fileURLToPath(new URL("../data/afk.json", import.meta.url));

export type Away = {
  since: string; // ISO
  until?: string; // ISO; without it, AFK lasts until "back"
  reason?: string;
};

export type AfkCommand = { on: true; until?: Date; reason?: string } | { on: false };

const BACK = /^(back|afk off)[.!]*$/i;
const AFK = /^afk\b\s*(.*)$/is;
const DURATION = /^(?:for\s+)?(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?)\b\s*/i;
const UNTIL = /^(?:until|till|til)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*/i;

// "afk", "afk lunch", "afk 45m", "afk 1h lunch", "afk until 14:00", "afk till 2pm dentist", "back".
export function parseAfkCommand(text: string, now = new Date()): AfkCommand | undefined {
  const trimmed = text.trim();
  if (BACK.test(trimmed)) return { on: false };
  const match = AFK.exec(trimmed);
  if (!match) return undefined;
  let rest = match[1].trim();
  let until: Date | undefined;

  const duration = DURATION.exec(rest);
  const time = UNTIL.exec(rest);
  if (duration) {
    const minutes = Number(duration[1]) * (duration[2].toLowerCase().startsWith("h") ? 60 : 1);
    until = new Date(now.getTime() + minutes * 60_000);
    rest = rest.slice(duration[0].length);
  } else if (time) {
    until = nextTime(now, Number(time[1]), Number(time[2] ?? 0), time[3]?.toLowerCase());
    rest = rest.slice(time[0].length);
  }
  const reason = rest.replace(/^[-–:,]\s*/, "").trim();
  return { on: true, until, reason: reason || undefined };
}

// the next time the clock shows hour:minute. Without am/pm, "until 2" at 1pm means 2pm, not 2am tomorrow.
function nextTime(now: Date, hour: number, minute: number, meridiem?: string): Date {
  let h = hour % 12;
  if (meridiem === "pm" || (!meridiem && hour >= 12)) h += 12;
  const at = new Date(now);
  at.setHours(h, minute, 0, 0);
  if (at <= now && !meridiem && hour < 12) at.setHours(h + 12);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// "away (lunch) until 14:00", for logs and prompts.
export const describeAway = (away: Away) =>
  `away${away.reason ? ` (${away.reason})` : ""}${away.until ? ` until ${clock(away.until)}` : ""}`;

// the note a teammate gets when the agent can't answer while the user is away.
export function awayNote(away: Away, { urgent = false } = {}): string {
  const reason = away.reason ? ` (${away.reason})` : "";
  const back = away.until ? `, back around ${clock(away.until)}` : "";
  const flagged = urgent ? `I've flagged this to ${USER_NAME} as urgent.` : `I'll make sure ${USER_NAME} sees this.`;
  return `${USER_NAME} is away${reason}${back}. ${flagged}`;
}

export class AfkMode {
  private away: Away | undefined;

  constructor(
    private file = AFK_FILE,
    // called when an AFK period runs out on its own.
    private onExpired?: (away: Away) => void,
    private now = () => new Date(),
  ) {
    try {
      if (existsSync(file)) this.away = JSON.parse(readFileSync(file, "utf8")) as Away;
    } catch {
      this.away = undefined;
    }
  }

  // the AFK period in force, if any. One that has run out is ended here.
  current(): Away | undefined {
    if (this.away?.until && new Date(this.away.until) <= this.now()) {
      const expired = this.away;
      this.clear();
      this.onExpired?.(expired);
    }
    return this.away;
  }

  start(until?: Date, reason?: string): Away {
    this.away = { since: this.now().toISOString(), until: until?.toISOString(), reason };
    this.save();
    return this.away;
  }

  // ends AFK mode, returning the period that was in force.
  end(): Away | undefined {
    const away = this.current();
    this.clear();
    return away;
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.away, null, 2));
  }

  private clear() {
    this.away = undefined;
    rmSync(this.file, { force: true });
  }
}
