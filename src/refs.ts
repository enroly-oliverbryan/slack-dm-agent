// PR numbers and Jira keys mentioned in a message

// magic regex stuff
const PR_PATTERNS = [/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/gi, /\bPRs?\s*#?(\d+)\b/gi, /(?<![\w/&])#(\d+)\b/g];
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

export function extractRefs(text: string): { prs: number[]; jiraKeys: string[] } {
  const prs = new Set<number>();
  for (const pattern of PR_PATTERNS) for (const m of text.matchAll(pattern)) prs.add(Number(m[1]));
  const jiraKeys = new Set([...text.matchAll(JIRA_KEY)].map((m) => m[1]));
  return { prs: [...prs].sort((a, b) => a - b), jiraKeys: [...jiraKeys].sort() };
}
