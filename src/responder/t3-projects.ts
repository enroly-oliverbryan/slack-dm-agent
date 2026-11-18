// the T3 project IDs for the folders in project_roots, looked up with the t3 CLI before a responder session, so the
// model can list and search threads straight away instead of calling t3_project_list first.
//
// `t3 thread list --project <folder> --json` returns that project's threads with their projectId. A project with no
// threads has nothing to read anyway, so missing it costs nothing.

import { execFile } from "node:child_process";
import { existsSync, globSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CACHE_MS = 10 * 60_000;

// under launchd, ~/.t3/bin may not be on PATH.
const t3Cli = () => {
  const local = join(homedir(), ".t3", "bin", "t3");
  return process.env.T3CODE_CLI_PATH ?? (existsSync(local) ? local : "t3");
};

const folders = (roots: string[]) =>
  [...new Set(roots.flatMap((root) => (/[*?[]/.test(root) ? globSync(root) : [root])))].filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });

async function projectIdFor(folder: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(t3Cli(), ["thread", "list", "--project", folder, "--json"], { timeout: 10_000 });
    const threads = JSON.parse(stdout) as { projectId?: string }[];
    return threads.find((t) => t.projectId)?.projectId;
  } catch {
    return undefined; // not a T3 project, no threads, or the CLI isn't available
  }
}

let cache: { at: number; key: string; projects: Map<string, string> } | undefined;

// project id -> folder, for every allowed folder that is a T3 project with threads.
export async function allowedT3Projects(roots: string[]): Promise<Map<string, string>> {
  const key = roots.join("\n");
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.projects;
  const found = await Promise.all(folders(roots).map(async (folder) => [await projectIdFor(folder), folder] as const));
  const projects = new Map(found.filter((entry): entry is [string, string] => !!entry[0]));
  cache = { at: Date.now(), key, projects };
  return projects;
}
