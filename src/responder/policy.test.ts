import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { checkPath, decide, sessionDirGlob, T3, T3Scope } from "./policy.ts";

const ROOTS = ["/work/app", "/work/app-*"];

describe("checkPath", () => {
  it("allows files inside a root or a root glob", () => {
    assert.equal(checkPath("/work/app/src/index.ts", ROOTS), undefined);
    assert.equal(checkPath("/work/app-3/src/index.ts", ROOTS), undefined);
    assert.equal(checkPath("/work/app", ROOTS), undefined);
  });

  it("denies other folders, look-alike prefixes and traversal", () => {
    assert.ok(checkPath("/work/other/x.ts", ROOTS));
    assert.ok(checkPath("/work/apple/x.ts", ROOTS));
    assert.ok(checkPath("/work/app/../other/x.ts", ROOTS));
    assert.ok(checkPath(undefined, ROOTS));
  });

  it("denies secret-looking files but allows .env.example", () => {
    assert.ok(checkPath("/work/app/.env", ROOTS));
    assert.ok(checkPath("/work/app/.env.local", ROOTS));
    assert.ok(checkPath("/work/app/certs/server.pem", ROOTS));
    assert.equal(checkPath("/work/app/.env.example", ROOTS), undefined);
  });

  it("allows the Claude Code session folders of allowed roots", () => {
    assert.equal(sessionDirGlob("/work/app-*"), `${homedir()}/.claude/projects/-work-app-*`);
    assert.equal(checkPath(`${homedir()}/.claude/projects/-work-app-3/abc.jsonl`, ROOTS), undefined);
    assert.ok(checkPath(`${homedir()}/.claude/projects/-work-other/abc.jsonl`, ROOTS));
  });
});

describe("T3Scope", () => {
  const projects = JSON.stringify({
    projects: [
      { id: "p-app", workspaceRoot: "/work/app" },
      { id: "p-other", workspaceRoot: "/work/other" },
    ],
  });
  const search = JSON.stringify({
    matches: [
      { threadId: "t-app", projectId: "p-app" },
      { threadId: "t-other", projectId: "p-other" },
    ],
  });

  it("needs t3_project_list first, then allows all-project or allowed-project searches", () => {
    const scope = new T3Scope(ROOTS);
    assert.ok(scope.check(`${T3}t3_thread_search`, { query: "x" }));

    scope.record(`${T3}t3_project_list`, [{ type: "text", text: projects }]);
    assert.deepEqual([...scope.projects.keys()], ["p-app"]);
    assert.equal(scope.check(`${T3}t3_thread_search`, { query: "x" }), undefined);
    assert.equal(scope.check(`${T3}t3_thread_list`, { allProjects: true }), undefined);
    assert.equal(scope.check(`${T3}t3_thread_search`, { query: "x", projectId: "p-app" }), undefined);
    assert.ok(scope.check(`${T3}t3_thread_search`, { query: "x", projectId: "p-other" }));
  });

  it("only reads threads from allowed projects that a search or list returned", () => {
    const scope = new T3Scope(ROOTS);
    scope.record(`${T3}t3_project_list`, [{ type: "text", text: projects }]);
    assert.ok(scope.check(`${T3}t3_thread_read`, { threadId: "t-app" }));
    scope.record(`${T3}t3_thread_search`, [{ type: "text", text: search }]);
    assert.equal(scope.check(`${T3}t3_thread_read`, { threadId: "t-app" }), undefined);
    assert.ok(scope.check(`${T3}t3_thread_read`, { threadId: "t-other" }));
  });

  it("strips other projects and their threads from responses", () => {
    const scope = new T3Scope(ROOTS);
    scope.record(`${T3}t3_project_list`, [{ type: "text", text: projects }]);
    const [projectBlock] = scope.filter([{ type: "text", text: projects }]) as { text: string }[];
    assert.deepEqual(
      JSON.parse(projectBlock.text).projects.map((p: { id: string }) => p.id),
      ["p-app"],
    );
    const [searchBlock] = scope.filter([{ type: "text", text: search }]) as { text: string }[];
    assert.deepEqual(
      JSON.parse(searchBlock.text).matches.map((m: { threadId: string }) => m.threadId),
      ["t-app"],
    );
  });

  it("hides settled threads and asks t3_thread_list for unsettled ones only", () => {
    const scope = new T3Scope(ROOTS);
    scope.record(`${T3}t3_project_list`, [{ type: "text", text: projects }]);
    const list = JSON.stringify({
      threads: [
        { threadId: "t-live", projectId: "p-app", settled: false },
        { threadId: "t-done", projectId: "p-app", settled: true },
      ],
    });
    const filtered = scope.filter([{ type: "text", text: list }]);
    scope.record(`${T3}t3_thread_list`, filtered);
    assert.deepEqual(
      JSON.parse((filtered as { text: string }[])[0].text).threads.map((t: { threadId: string }) => t.threadId),
      ["t-live"],
    );
    assert.ok(scope.check(`${T3}t3_thread_read`, { threadId: "t-done" }));

    const decision = decide(`${T3}t3_thread_list`, { limit: 5 }, ROOTS, scope);
    assert.deepEqual(decision, { allow: true, input: { limit: 5, settled: false } });
  });

  it("denies t3 tools that change things", () => {
    const scope = new T3Scope(ROOTS);
    assert.ok(scope.check(`${T3}t3_thread_send`, { threadId: "t-app", message: "hi" }));
    assert.ok(scope.check(`${T3}t3_project_delete`, { projectId: "p-app" }));
  });
});

describe("decide", () => {
  it("allows the SDK's StructuredOutput tool, which carries the final answer", () => {
    assert.equal(decide("StructuredOutput", {}, ROOTS, new T3Scope(ROOTS)).allow, true);
  });

  it("allows Atlassian reads and denies its writes", () => {
    const scope = new T3Scope(ROOTS);
    assert.equal(decide("mcp__atlassian__getJiraIssue", {}, ROOTS, scope).allow, true);
    assert.equal(decide("mcp__atlassian__editJiraIssue", {}, ROOTS, scope).allow, false);
    assert.equal(decide("mcp__atlassian__executeRead", {}, ROOTS, scope).allow, false);
  });

  it("denies tools outside the allowlist", () => {
    const decision = decide("Bash", { command: "ls" }, ROOTS, new T3Scope(ROOTS));
    assert.equal(decision.allow, false);
  });
});
