// try triage on messages without Slack: pnpm triage "hey" "how does the retry in #123 work?"
import { triage } from "./triage.ts";

const messages = process.argv.slice(2);
if (!messages.length) {
  console.error('usage: pnpm triage "<message>" ["<message>" ...]');
  process.exit(1);
}
console.log(await triage({ sender: "Teammate", history: [], messages }));
