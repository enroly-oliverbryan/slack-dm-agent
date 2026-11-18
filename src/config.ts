import { readFileSync } from "node:fs";
import { homedir } from "node:os";

type RawConfig = {
  // send_to_teammate: true sends replies to that person. Unset or false, their replies go to the user's self-DM
  // instead (with the teammate's name in the header) and holding replies are skipped. Test messages always get their
  // reply in the self-DM.
  allowlist: { id: string; name: string; send_to_teammate?: boolean }[];
  // quiet time after a teammate's last message before the burst is handled.
  debounce_seconds?: number;
  // a teammate message this soon after the user's own message in the DM is left to the user.
  recent_reply_seconds?: number;
  // skip bursts while the user's Slack presence is "active".
  skip_when_active?: boolean;
  // drafts below this confidence would be swapped for a holding reply.
  confidence_threshold?: number;
  sources?: {
    // local repo folders the responder may read code from, and whose T3 threads and Claude Code sessions it may
    // read. Globs allowed, ~ expands. Nothing outside these is readable.
    project_roots?: string[];
    // "owner/name" repos the responder may read PRs from with gh.
    github_repos?: string[];
    // the t3-code MCP URL (claude mcp get t3-code). Leave out to run without T3 context.
    t3_mcp_url?: string;
    // the Atlassian MCP URL (claude mcp get atlassian). Leave out to run without Jira and Confluence.
    atlassian_mcp_url?: string;
  };
};

const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir());

const raw: RawConfig = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));

const badIds = raw.allowlist.filter((user) => !user.id.startsWith("U") && !user.id.startsWith("W"));
if (badIds.length) {
  throw new Error(
    `config.json allowlist needs user IDs (U...), not channel IDs: ${badIds.map((p) => p.id).join(", ")}`,
  );
}

export const config = {
  allowlist: new Map(raw.allowlist.map((p) => [p.id, p.name])),
  // whether replies to this teammate go to them, or to the user's self-DM.
  sendsTo: (userId: string) => raw.allowlist.find((p) => p.id === userId)?.send_to_teammate === true,
  debounceSeconds: raw.debounce_seconds ?? 45,
  recentReplySeconds: raw.recent_reply_seconds ?? 300,
  skipWhenActive: raw.skip_when_active ?? false,
  confidenceThreshold: raw.confidence_threshold ?? 0.7,
  projectRoots: (raw.sources?.project_roots ?? []).map(expandHome),
  githubRepos: raw.sources?.github_repos ?? [],
  t3McpUrl: raw.sources?.t3_mcp_url,
  atlassianMcpUrl: raw.sources?.atlassian_mcp_url,
};
