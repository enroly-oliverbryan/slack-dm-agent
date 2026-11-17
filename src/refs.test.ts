import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractRefs } from "./refs.ts";

describe("extractRefs", () => {
  it("finds PRs from links, 'PR 123' and '#123'", () => {
    const text = "see <https://github.com/acme/app/pull/4521|this>, also PR 4530 and #4502";
    assert.deepEqual(extractRefs(text).prs, [4502, 4521, 4530]);
  });

  it("finds Jira keys bare and in links, once each", () => {
    const text = "is CAS-1234 done? <https://acme.atlassian.net/browse/CAS-1234|CAS-1234> and APPLY-9";
    assert.deepEqual(extractRefs(text).jiraKeys, ["APPLY-9", "CAS-1234"]);
  });

  it("ignores Slack channel links and URL fragments", () => {
    const text = "posted in <#C0123ABC|dev>, see https://docs.example.com/page#42";
    assert.deepEqual(extractRefs(text), { prs: [], jiraKeys: [] });
  });

  it("returns nothing for plain chat", () => {
    assert.deepEqual(extractRefs("thanks!"), { prs: [], jiraKeys: [] });
  });
});
