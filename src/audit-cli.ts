// read the audit log: `pnpm audit-log` lists recent bursts, `pnpm audit-log <id>` shows one in full,
// `pnpm audit-log --limit 50` lists more.
import { burstById, recentBursts } from "./audit.ts";

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 20;
const id = args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== "--limit");

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

if (id) {
  const row = burstById(Number(id));
  if (!row) {
    console.error(`no burst #${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify(row, null, 2));
} else {
  const rows = recentBursts(limit).reverse();
  if (!rows.length) console.log("no bursts logged yet");
  for (const r of rows) {
    const when = new Date(r.at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
    const detail =
      r.holdReason ??
      (r.confidence !== undefined ? `confidence ${r.confidence.toFixed(2)}` : (r.triageReason ?? r.error ?? ""));
    console.log(
      `#${r.id}  ${when}  ${r.senderName}${r.test ? " (test)" : ""}  ${r.outcome ?? "?"}` +
        `${r.sentTo ? ` -> ${r.sentTo}` : ""}` +
        `  $${r.costUsd.toFixed(3)}\n` +
        `    in:  ${oneLine(r.messages.join(" / "), 110)}\n` +
        (r.sentText ? `    out: ${oneLine(r.sentText, 110)}\n` : "") +
        (detail ? `    why: ${oneLine(detail, 110)}\n` : ""),
    );
  }
}
