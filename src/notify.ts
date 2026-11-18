// macOS notifications. terminal-notifier (brew install terminal-notifier) lets a notification open the Slack DM when
// clicked and be removed later by its group; without it, osascript shows a plain notification.

import { execFile, execFileSync } from "node:child_process";

const terminalNotifier = (() => {
  try {
    return execFileSync("which", ["terminal-notifier"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

export type NotifyOptions = {
  loud?: boolean; // play a sound
  group?: string; // lets removeNotification() take it back
  open?: string; // URL opened on click, e.g. a slack:// link to the DM
};

export function notify(title: string, body: string, { loud = false, group, open }: NotifyOptions = {}) {
  if (terminalNotifier) {
    const args = ["-title", title, "-message", body];
    if (loud) args.push("-sound", "Sosumi");
    if (group) args.push("-group", group);
    if (open) args.push("-open", open);
    execFile(terminalNotifier, args);
    return;
  }
  // AppleScript string literal: escape backslashes and quotes.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sound = loud ? ' sound name "Sosumi"' : "";
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"${sound}`]);
}

export function removeNotification(group: string) {
  if (terminalNotifier) execFile(terminalNotifier, ["-remove", group]);
}

export const slackLink = (teamId: string | undefined, channel: string) =>
  teamId ? `slack://channel?team=${teamId}&id=${channel}` : undefined;
