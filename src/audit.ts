// one row per burst in data/agent.db: what came in, how triage saw it, what the responder drafted and why, and what
// was sent where. Lets the user answer "why did it say that?" after the fact.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const DB_FILE = fileURLToPath(new URL("../data/agent.db", import.meta.url));

export type Outcome =
  | "answered" // the draft was sent (to the teammate, or to the self-DM)
  | "held-back" // the responder drafted, but a holding reply went (or nothing, when sending is off)
  | "deferred" // triage left it for the user
  | "ignored" // triage found nothing to reply to
  | "responder-failed"
  | "triage-failed"
  | "skipped-active"; // the user was active on Slack

export type AuditRecord = {
  at: string;
  channel: string;
  senderId: string;
  senderName: string;
  test: boolean;
  messages: string[];
  outcome?: Outcome;
  holdReason?: string;
  triageAction?: string;
  triageUrgent?: boolean;
  triageReason?: string;
  topics?: string[];
  prs?: number[];
  jiraKeys?: string[];
  draft?: string;
  confidence?: number;
  needsUser?: boolean;
  sources?: string[];
  reasoning?: string;
  toolCalls?: string[];
  t3Problem?: string;
  sentText?: string;
  sentTo?: string; // "teammate" | "self-dm" | "skipped"
  replyChannel?: string; // where the reply was posted, and its ts: how a reaction finds its burst
  replyTs?: string;
  feedback?: "good" | "bad"; // the recipient's ✅ / ❌ on the reply
  feedbackAt?: string;
  error?: string;
  costUsd: number;
  durationMs?: number;
};

// record field -> column. JSON columns hold arrays; booleans are 0/1.
const COLUMNS = {
  at: "TEXT NOT NULL",
  channel: "TEXT NOT NULL",
  senderId: "TEXT NOT NULL",
  senderName: "TEXT NOT NULL",
  test: "INTEGER NOT NULL",
  messages: "TEXT NOT NULL",
  outcome: "TEXT",
  holdReason: "TEXT",
  triageAction: "TEXT",
  triageUrgent: "INTEGER",
  triageReason: "TEXT",
  topics: "TEXT",
  prs: "TEXT",
  jiraKeys: "TEXT",
  draft: "TEXT",
  confidence: "REAL",
  needsUser: "INTEGER",
  sources: "TEXT",
  reasoning: "TEXT",
  toolCalls: "TEXT",
  t3Problem: "TEXT",
  sentText: "TEXT",
  sentTo: "TEXT",
  replyChannel: "TEXT",
  replyTs: "TEXT",
  feedback: "TEXT",
  feedbackAt: "TEXT",
  error: "TEXT",
  costUsd: "REAL NOT NULL",
  durationMs: "INTEGER",
} satisfies Record<keyof AuditRecord, string>;

const FIELDS = Object.keys(COLUMNS) as (keyof AuditRecord)[];
const column = (field: string) => field.replace(/[A-Z0-9]/g, (c) => `_${c.toLowerCase()}`);

let db: DatabaseSync | undefined;

function open(file = DB_FILE) {
  if (db) return db;
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS bursts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ${FIELDS.map((f) => `${column(f)} ${COLUMNS[f]}`).join(",\n    ")}
  )`);
  // tables from older versions get new columns added, never dropped.
  const existing = new Set((db.prepare("PRAGMA table_info(bursts)").all() as { name: string }[]).map((c) => c.name));
  for (const f of FIELDS)
    if (!existing.has(column(f)))
      db.exec(`ALTER TABLE bursts ADD COLUMN ${column(f)} ${COLUMNS[f].replace(" NOT NULL", "")}`);
  return db;
}

// for tests: use another file (or ":memory:").
export function useDatabase(file: string) {
  db?.close();
  db = undefined;
  open(file);
}

const toSql = (value: unknown) =>
  value === undefined
    ? null
    : Array.isArray(value)
      ? JSON.stringify(value)
      : typeof value === "boolean"
        ? Number(value)
        : value;

// never throws: a logging failure mustn't stop a reply.
export function recordBurst(record: AuditRecord): number | undefined {
  try {
    const statement = open().prepare(
      `INSERT INTO bursts (${FIELDS.map(column).join(", ")}) VALUES (${FIELDS.map(() => "?").join(", ")})`,
    );
    const result = statement.run(...FIELDS.map((f) => toSql(record[f]) as string | number | null));
    return Number(result.lastInsertRowid);
  } catch (error) {
    console.error("audit log write failed:", error);
    return undefined;
  }
}

export type AuditRow = { id: number } & AuditRecord;

function fromRow(row: Record<string, unknown>): AuditRow {
  const out: Record<string, unknown> = { id: row.id };
  for (const f of FIELDS) {
    const value = row[column(f)];
    if (value === null) continue;
    if (["messages", "topics", "prs", "jiraKeys", "sources", "toolCalls"].includes(f))
      out[f] = JSON.parse(value as string);
    else if (["test", "triageUrgent", "needsUser"].includes(f)) out[f] = value === 1;
    else out[f] = value;
  }
  return out as AuditRow;
}

export function recentBursts(limit = 20): AuditRow[] {
  return (open().prepare("SELECT * FROM bursts ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(
    fromRow,
  );
}

export function burstById(id: number): AuditRow | undefined {
  const row = open().prepare("SELECT * FROM bursts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row && fromRow(row);
}

export function burstByReply(channel: string, ts: string): AuditRow | undefined {
  const row = open().prepare("SELECT * FROM bursts WHERE reply_channel = ? AND reply_ts = ?").get(channel, ts) as
    Record<string, unknown> | undefined;
  return row && fromRow(row);
}

export function setFeedback(id: number, feedback: "good" | "bad") {
  try {
    open()
      .prepare("UPDATE bursts SET feedback = ?, feedback_at = ? WHERE id = ?")
      .run(feedback, new Date().toISOString(), id);
  } catch (error) {
    console.error("audit log feedback write failed:", error);
  }
}
