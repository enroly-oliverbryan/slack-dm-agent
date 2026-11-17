// groups a teammate's messages in a DM into one burst, released after a quiet period.
// a burst is dropped if the user posts in that DM while it's pending, or posted recently before it.

export type Message = { ts: string; text: string };
export type Burst = { channel: string; user: string; messages: Message[] };
export type AddResult = "pending" | "user-here";

type Pending = { burst: Burst; timer: NodeJS.Timeout };

// slack ts is "<seconds>.<micro>".
const seconds = (ts: string) => Number.parseFloat(ts);

export class BurstTracker {
  private pending = new Map<string, Pending>();
  // ts of the user's latest message per DM channel.
  private lastSelfTs = new Map<string, string>();

  constructor(
    private opts: {
      quietMs: number;
      // a teammate message this soon after the user's own message in the DM means the user is in the conversation.
      recentReplyMs: number;
      onReady: (burst: Burst) => void;
    },
  ) {}

  add(channel: string, user: string, message: Message): AddResult {
    const lastSelf = this.lastSelfTs.get(channel);
    if (lastSelf && (seconds(message.ts) - seconds(lastSelf)) * 1000 < this.opts.recentReplyMs) {
      this.cancel(channel);
      return "user-here";
    }

    const existing = this.pending.get(channel);
    if (existing) clearTimeout(existing.timer);

    const burst = existing?.burst ?? { channel, user, messages: [] };
    burst.messages.push(message);

    const timer = setTimeout(() => {
      this.pending.delete(channel);
      this.opts.onReady(burst);
    }, this.opts.quietMs);
    this.pending.set(channel, { burst, timer });
    return "pending";
  }

  // the user posted in this DM. Returns the burst it cancelled, if any.
  selfPosted(channel: string, ts: string): Burst | undefined {
    this.lastSelfTs.set(channel, ts);
    return this.cancel(channel);
  }

  private cancel(channel: string): Burst | undefined {
    const existing = this.pending.get(channel);
    if (!existing) return undefined;
    clearTimeout(existing.timer);
    this.pending.delete(channel);
    return existing.burst;
  }
}
