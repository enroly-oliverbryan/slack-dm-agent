// try the responder without Slack:
//   pnpm respond "how does the burst debounce work?"
//   pnpm respond "what's this error?" --file ~/Desktop/error.png
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Attachments } from "./files.ts";
import { respond } from "./responder/agent.ts";
import { triage } from "./triage.ts";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const args = process.argv.slice(2);
const messages: string[] = [];
const attachments: Attachments = { images: [], texts: [], skipped: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--file") {
    messages.push(args[i]!);
    continue;
  }
  const path = args[++i]!;
  const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (mediaType)
    attachments.images.push({ name: basename(path), mediaType, data: readFileSync(path).toString("base64") });
  else attachments.texts.push({ name: basename(path), text: readFileSync(path, "utf8") });
}
if (!messages.length) {
  console.error('usage: pnpm respond "<message>" ["<message>" ...] [--file <path> ...]');
  process.exit(1);
}
const hasFiles = attachments.images.length + attachments.texts.length > 0;
const result = await triage({
  sender: "Teammate",
  history: [],
  messages,
  attachments: hasFiles ? attachments : undefined,
});
console.log("triage:", result.action, "-", result.reason);
const draft = await respond({
  senderId: "test",
  senderName: "Teammate",
  messages,
  history: [],
  ...result,
  attachments: hasFiles ? attachments : undefined,
});
console.log(draft);
