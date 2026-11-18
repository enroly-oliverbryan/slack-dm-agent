// what the responder may read. Everything not allowed here is denied.
// Pure apart from realpath, so it can be tested without a model.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, matchesGlob, resolve, sep } from "node:path";

export const T3 = "mcp__t3-code__";
export const GITHUB_TOOL = "mcp__github__pr";
export const ATLASSIAN = "mcp__atlassian__";

// Jira and Confluence reads only. Writes, the generic execute* tools and people/activity lookups stay out.
const ATLASSIAN_READS = new Set([
  "getAccessibleAtlassianResources",
  "getJiraIssue",
  "searchJiraIssuesUsingJql",
  "listJiraIssueComments",
  "searchConfluence",
  "getConfluenceContent",
  "search",
]);

const SECRET_FILE = [
  /^\.env(?!\.(example|sample|template)$)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)/i,
  /^\.(npmrc|netrc|pgpass)$/i,
  /credentials|secrets?\./i,
];

// Claude Code keeps a project's sessions in ~/.claude/projects/<cwd with every non-alphanumeric as "-">.
export const sessionDirGlob = (root: string) => `${homedir()}/.claude/projects/${root.replace(/[^a-zA-Z0-9*?]/g, "-")}`;

// true if `path` is `glob` itself or inside a folder matching it.
function underGlob(path: string, glob: string) {
  const depth = glob.split(sep).length;
  const prefix = path.split(sep).slice(0, depth).join(sep);
  return matchesGlob(prefix, glob);
}

function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path); // doesn't exist yet: the tool will fail on its own
  }
}

export function checkPath(path: unknown, roots: string[]): string | undefined {
  if (typeof path !== "string" || !path) return "pass an absolute path inside one of the allowed folders";
  const target = real(resolve(path));
  if (SECRET_FILE.some((re) => re.test(basename(target)))) return `${basename(target)} may hold secrets`;
  const allowed = roots.flatMap((root) => [root, sessionDirGlob(root)]);
  if (!allowed.some((glob) => underGlob(target, glob))) return `${path} is outside the allowed folders`;
  return undefined;
}

// T3 threads: only projects whose folder is an allowed root, and only threads the scoped searches returned.
export class T3Scope {
  readonly projects = new Map<string, string>(); // allowed project id -> folder
  private threads = new Set<string>();

  // `known`: allowed project ids looked up before the session (see t3-projects.ts), so t3_project_list isn't needed.
  constructor(
    private roots: string[],
    known: Map<string, string> = new Map(),
  ) {
    for (const [id, folder] of known) this.projects.set(id, folder);
  }

  // feed every t3 tool response through here.
  record(toolName: string, response: unknown) {
    for (const obj of jsonObjects(response)) {
      if (toolName === `${T3}t3_project_list` && typeof obj.id === "string" && typeof obj.workspaceRoot === "string") {
        if (this.roots.some((root) => underGlob(obj.workspaceRoot as string, root)))
          this.projects.set(obj.id, obj.workspaceRoot);
      }
      const threadId = obj.threadId ?? (toolName === `${T3}t3_thread_list` ? obj.id : undefined);
      if (typeof threadId === "string" && typeof obj.projectId === "string" && this.projects.has(obj.projectId))
        this.threads.add(threadId);
    }
  }

  // the tool response without settled threads, or projects, threads and search matches outside the allowed folders.
  filter(response: unknown): unknown {
    const allowed = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      const obj = value as Record<string, unknown>;
      if (
        typeof obj.workspaceRoot === "string" &&
        !this.roots.some((root) => underGlob(obj.workspaceRoot as string, root))
      )
        return false;
      if (obj.settled === true) return false; // unfinished or discarded work
      return typeof obj.projectId !== "string" || this.projects.has(obj.projectId);
    };
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") {
        try {
          return JSON.stringify(walk(JSON.parse(value)));
        } catch {
          return value;
        }
      }
      if (Array.isArray(value)) return value.filter(allowed).map(walk);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
      return value;
    };
    return walk(response);
  }

  check(toolName: string, input: Record<string, unknown>): string | undefined {
    const name = toolName.slice(T3.length);
    if (name === "t3_project_list") return undefined;
    if (name === "t3_thread_search" || name === "t3_thread_list") {
      if (input.environmentId) return "environmentId isn't allowed";
      if (!this.projects.size) return "call t3_project_list first";
      // no projectId means every project: filter() strips the ones outside the allowed folders from the result.
      if (input.projectId === undefined || this.projects.has(input.projectId as string)) return undefined;
      return `projectId must be one of: ${[...this.projects].map(([id, root]) => `${id} (${root})`).join(", ")}, or left out for all of them`;
    }
    if (name === "t3_thread_read") {
      if (input.environmentId) return "environmentId isn't allowed";
      if (typeof input.threadId === "string" && this.threads.has(input.threadId)) return undefined;
      return "only threads returned by t3_thread_search or t3_thread_list in an allowed project can be read";
    }
    return `${name} isn't allowed`;
  }
}

// every object nested anywhere in a tool response, including JSON inside text blocks.
function* jsonObjects(value: unknown): Generator<Record<string, unknown>> {
  if (typeof value === "string") {
    try {
      yield* jsonObjects(JSON.parse(value));
    } catch {
      // plain text
    }
  } else if (Array.isArray(value)) {
    for (const item of value) yield* jsonObjects(item);
  } else if (value && typeof value === "object") {
    yield value as Record<string, unknown>;
    for (const child of Object.values(value)) yield* jsonObjects(child);
  }
}

// `input` replaces the tool input when the policy needs to narrow it.
export type Decision = { allow: true; input?: Record<string, unknown> } | { allow: false; reason: string };

export function decide(toolName: string, input: Record<string, unknown>, roots: string[], t3: T3Scope): Decision {
  let reason: string | undefined;
  if (toolName === "Read") reason = checkPath(input.file_path, roots);
  else if (toolName === "Grep" || toolName === "Glob") reason = checkPath(input.path, roots);
  else if (toolName.startsWith(T3)) reason = t3.check(toolName, input);
  else if (toolName.startsWith(ATLASSIAN))
    reason = ATLASSIAN_READS.has(toolName.slice(ATLASSIAN.length)) ? undefined : `${toolName} isn't available`;
  // the repo allowlist is enforced inside the GitHub tool; StructuredOutput is how the SDK returns the final answer.
  else if (toolName === GITHUB_TOOL || toolName === "StructuredOutput") reason = undefined;
  else reason = `${toolName} isn't available`;
  if (reason) return { allow: false, reason };
  // settled threads are often unfinished or discarded work: never list them.
  if (toolName === `${T3}t3_thread_list`) return { allow: true, input: { ...input, settled: false } };
  return { allow: true };
}
