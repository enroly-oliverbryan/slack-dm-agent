// last check on outgoing text: anything that looks like a credential blocks the reply.

const SECRETS: [string, RegExp][] = [
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprse]-[0-9A-Za-z-]{10,}/],
  ["GitHub token", /\b(gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})/],
  ["Anthropic key", /\bsk-ant-[0-9A-Za-z_-]{20,}/],
  ["API key", /\bsk-[0-9A-Za-z]{32,}/],
  ["JWT", /\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["credential in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/i],
  [
    "secret assignment",
    /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"'`]{8,}/i,
  ],
];

// names what looks like a secret, or undefined if the text is clean.
export function findSecret(text: string): string | undefined {
  return SECRETS.find(([, pattern]) => pattern.test(text))?.[0];
}
