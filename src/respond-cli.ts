// try the responder without Slack: pnpm respond "how does the burst debounce work?"
import { respond } from "./responder/agent.ts";
import { triage } from "./triage.ts";

const messages = process.argv.slice(2);
if (!messages.length) {
  console.error('usage: pnpm respond "<message>" ["<message>" ...]');
  process.exit(1);
}
const result = await triage({ sender: "Teammate", history: [], messages });
console.log("triage:", result.action, "-", result.reason);
const draft = await respond({ senderId: "test", senderName: "Teammate", messages, history: [], ...result });
console.log(draft);
