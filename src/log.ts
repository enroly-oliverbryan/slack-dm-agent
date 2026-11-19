// terminal output. By default: one line per handled burst, and problems. VERBOSE=1 adds everything else
// (incoming messages, triage reasoning, drafts). The full record of each burst is in the audit log either way.

export const VERBOSE = /^(1|true|yes)$/i.test(process.env.VERBOSE ?? "");

const time = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const warned = new Set<string>();

export const log = {
  info: (message: string) => console.log(`${time()} ${message}`),
  debug: (message: string) => {
    if (VERBOSE) console.log(`${time()} ${message}`);
  },
  warn: (message: string, error?: unknown) =>
    console.warn(`${time()} ⚠ ${message}${error === undefined ? "" : `: ${reason(error)}`}`),
  // for problems that repeat until fixed (a missing scope, an expired login): shown once per run.
  warnOnce: (key: string, message: string, error?: unknown) => {
    if (warned.has(key)) return;
    warned.add(key);
    log.warn(message, error);
  },
  error: (message: string, error?: unknown) => {
    console.error(`${time()} ✖ ${message}${error === undefined ? "" : `: ${reason(error)}`}`);
    if (VERBOSE && error instanceof Error && error.stack) console.error(error.stack);
  },
};

// a message shortened to one line, for log lines.
export function short(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
