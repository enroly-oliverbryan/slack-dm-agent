// read-only GitHub access for the responder: one tool that wraps a few `gh` commands, limited to configured repos.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const run = promisify(execFile);
const MAX_CHARS = 60_000;

const text = (body: string) => ({
  content: [
    { type: "text" as const, text: body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n[truncated]` : body },
  ],
});

export function githubServer(repos: string[]) {
  return createSdkMcpServer({
    name: "github",
    tools: [
      tool(
        "pr",
        `Read GitHub pull requests (read-only). Repos: ${repos.join(", ") || "none configured"}.
- view: title, description, state, branches, author, size and review status of PR \`number\`
- diff: the diff of PR \`number\` (large diffs are truncated)
- search: up to 10 PRs matching \`query\` (GitHub search syntax, e.g. "retry in:title" or "author:@me")`,
        {
          action: z.enum(["view", "diff", "search"]),
          repo: z
            .string()
            .optional()
            .describe(`owner/name, defaults to ${repos[0] ?? "the first configured repo"}`),
          number: z.number().int().positive().optional(),
          query: z.string().optional(),
        },
        async ({ action, repo = repos[0], number, query }) => {
          if (!repo || !repos.includes(repo))
            return { ...text(`repo must be one of: ${repos.join(", ")}`), isError: true };
          try {
            if (action === "search") {
              if (!query) return { ...text("search needs a query"), isError: true };
              const fields = "number,title,state,author,url,updatedAt";
              const { stdout } = await run("gh", [
                "pr",
                "list",
                "--repo",
                repo,
                "--state",
                "all",
                "--search",
                query,
                "--limit",
                "10",
                "--json",
                fields,
              ]);
              return text(stdout);
            }
            if (!number) return { ...text(`${action} needs a PR number`), isError: true };
            if (action === "diff") {
              const { stdout } = await run("gh", ["pr", "diff", String(number), "--repo", repo], {
                maxBuffer: 20 * 1024 * 1024,
              });
              return text(stdout);
            }
            const fields =
              "number,title,body,state,author,url,headRefName,baseRefName,createdAt,mergedAt,additions,deletions,changedFiles,reviewDecision";
            const { stdout } = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", fields]);
            return text(stdout);
          } catch (error) {
            return { ...text(`gh failed: ${(error as Error).message}`), isError: true };
          }
        },
      ),
    ],
  });
}
