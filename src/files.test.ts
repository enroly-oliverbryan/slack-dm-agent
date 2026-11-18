import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { describeAttachments, imageBlocks, readAttachments, type SlackFile } from "./files.ts";

const file = (overrides: Partial<SlackFile>): SlackFile => ({
  id: "F1",
  name: "file",
  url_private_download: "https://files.slack.com/x",
  size: 10,
  ...overrides,
});

const respondWith = (body: string, contentType: string) =>
  mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": contentType } }));

describe("readAttachments", () => {
  afterEach(() => mock.restoreAll());

  it("reads images as base64 and text files inline", async () => {
    respondWith("hello", "application/octet-stream");
    const out = await readAttachments(
      [file({ name: "shot.png", mimetype: "image/png" }), file({ name: "err.log", mimetype: "text/plain" })],
      "xoxp-test",
    );
    assert.equal(out.images[0].data, Buffer.from("hello").toString("base64"));
    assert.deepEqual(out.texts, [{ name: "err.log", text: "hello" }]);
    assert.equal(imageBlocks(out).length, 1);
  });

  it("names files it can't read instead of dropping them", async () => {
    respondWith("<html>sign in</html>", "text/html");
    const out = await readAttachments(
      [
        file({ name: "spec.pdf", mimetype: "application/pdf" }),
        file({ name: "huge.png", mimetype: "image/png", size: 6 * 1024 * 1024 }),
        file({ name: "shot.png", mimetype: "image/png" }),
      ],
      "xoxp-test",
    );
    assert.deepEqual(
      out.skipped.map((s) => s.name),
      ["spec.pdf", "huge.png", "shot.png"],
    );
    assert.match(out.skipped[2].why, /login page/);
    assert.match(describeAttachments(out), /<unreadable name="spec.pdf">/);
  });
});
