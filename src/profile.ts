// the tone profile recon generated: style guide, per-person notes, example exchanges, holding replies.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = (path: string) => fileURLToPath(new URL(`../profile/${path}`, import.meta.url));
const read = (path: string) => (existsSync(file(path)) ? readFileSync(file(path), "utf8") : undefined);

type Example = { withUserId: string; withName: string; question: string; reply: string };

export const style = () => read("style.md") ?? "";

// Slack user IDs only, so a crafted ID can't reach outside profile/people.
export const personNotes = (userId: string) =>
  /^[UW][A-Z0-9]+$/.test(userId) ? read(`people/${userId}.md`) : undefined;

const examples = (): Example[] =>
  (read("examples.jsonl") ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Example);

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

// the exchanges most like this question: shared words, with a boost for the same person.
export function similarExamples(userId: string, question: string, count = 4): Example[] {
  const asked = words(question);
  return examples()
    .map((example) => {
      const overlap = [...words(example.question)].filter((w) => asked.has(w)).length;
      return { example, score: overlap + (example.withUserId === userId ? 2 : 0) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((s) => s.example);
}

export function holdingReply(): string {
  const replies: string[] = JSON.parse(read("holding-replies.json") ?? "[]");
  return replies[Math.floor(Math.random() * replies.length)] ?? "";
}
