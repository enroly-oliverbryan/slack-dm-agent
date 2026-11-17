import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findSecret } from "./guard.ts";

describe("findSecret", () => {
  it("catches common credential shapes", () => {
    assert.equal(findSecret("key is AKIAIOSFODNN7EXAMPLE"), "AWS access key");
    assert.equal(findSecret("use xoxb-1234567890-abcdefghij"), "Slack token");
    assert.equal(findSecret("ghp_" + "a".repeat(36)), "GitHub token");
    assert.equal(findSecret("-----BEGIN RSA PRIVATE KEY-----"), "private key");
    assert.equal(findSecret("postgres://admin:hunter22@db.internal:5432/app"), "credential in a URL");
    assert.equal(findSecret("set `STRIPE_SECRET_KEY=sk_live_abcdefgh12345`"), "secret assignment");
    assert.equal(findSecret("password: correcthorsebattery"), "secret assignment");
  });

  it("lets normal technical replies through", () => {
    assert.equal(findSecret("It's configurable: `debounce_seconds` in `config.json` (default 45)."), undefined);
    assert.equal(findSecret("See https://github.com/acme/app/pull/8841 and ENROLY-6676."), undefined);
    assert.equal(findSecret("The token is refreshed by `refreshToken()` in auth.ts."), undefined);
    assert.equal(findSecret("Set API_KEY in your .env (ask Oliver for the value)."), undefined);
  });
});
