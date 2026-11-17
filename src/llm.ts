import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";

// one-shot structured generation on the Claude Code login (no API key needed).
// no tools, no settings, no saved session: the model only sees the prompts.
export async function generate<T>(opts: {
  model: string;
  effort: EffortLevel;
  systemPrompt: string;
  prompt: string;
  schema: Record<string, unknown>;
}): Promise<{ output: T; costUsd: number }> {
  for await (const message of query({
    prompt: opts.prompt,
    options: {
      model: opts.model,
      effort: opts.effort,
      systemPrompt: opts.systemPrompt,
      tools: [],
      settingSources: [], // don't load CLAUDE.md or user settings into this run
      persistSession: false,
      outputFormat: { type: "json_schema", schema: opts.schema },
    },
  })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(`generation failed: ${message.subtype}`);
    return { output: message.structured_output as T, costUsd: message.total_cost_usd };
  }
  throw new Error("no result returned");
}
