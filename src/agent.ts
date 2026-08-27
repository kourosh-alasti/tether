/**
 * The agentic loop: stream a completion, execute any tool calls, feed results
 * back, repeat until the model answers in plain text. If the current model
 * fails (rate limit, dead endpoint, provider error) it is benched and the
 * next-best free model takes over transparently.
 */

import * as os from "node:os";
import {
  ApiError,
  ChatMessage,
  CompletionResult,
  OpenRouterClient,
  ToolCall,
} from "./openrouter.js";
import { ModelScout } from "./scout.js";
import { executeTool, ToolContext, toolDefinitions } from "./tools.js";
import { color, Spinner } from "./ui.js";

const MAX_STEPS_PER_TURN = 40;
const MAX_MODEL_ATTEMPTS = 5;
const DEFAULT_COOLDOWN_SECONDS = 90;

function systemPrompt(cwd: string): string {
  return [
    "You are Tether, a capable coding agent running in a terminal on the user's machine.",
    `Working directory: ${cwd}`,
    `Platform: ${os.platform()} (${os.arch()}), Node ${process.version}`,
    `Date: ${new Date().toDateString()}`,
    "",
    "Use the provided tools to inspect and modify the project and to run commands.",
    "Rules:",
    "- Always read a file before editing it; use edit_file for targeted changes and write_file only for new or fully rewritten files.",
    "- Use grep and list_dir to find your way around instead of guessing paths.",
    "- Verify your work when practical (build, test, run) using bash.",
    "- Keep going until the task is complete, then summarize what you did in a few short lines.",
    "- Ask for clarification only when truly blocked; otherwise make the reasonable choice and note it.",
    "- Output is rendered in a plain terminal: prefer short paragraphs and simple lists over heavy markdown.",
  ].join("\n");
}

export interface AgentOptions {
  client: OpenRouterClient;
  scout: ModelScout;
  toolContext: ToolContext;
}

export class Agent {
  private messages: ChatMessage[];
  private spinner = new Spinner();
  /** Model used for the last completed request; kept for the whole turn. */
  lastModel: string | undefined;

  constructor(private options: AgentOptions) {
    this.messages = [{ role: "system", content: systemPrompt(options.toolContext.cwd) }];
  }

  reset(): void {
    this.messages = [{ role: "system", content: systemPrompt(this.options.toolContext.cwd) }];
  }

  /** Run one user turn to completion. Returns the final assistant text. */
  async runTurn(userInput: string): Promise<string> {
    this.messages.push({ role: "user", content: userInput });

    for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
      const result = await this.completeWithFailover();
      this.messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      });

      if (result.toolCalls.length === 0) {
        return result.content;
      }
      for (const call of result.toolCalls) {
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await this.executeAndReport(call),
        });
      }
    }

    const notice = `[stopped after ${MAX_STEPS_PER_TURN} steps — ask me to continue if needed]`;
    console.log(color.yellow(notice));
    return notice;
  }

  private async executeAndReport(call: ToolCall): Promise<string> {
    console.log(
      `${color.magenta("⚒")} ${color.bold(call.function.name)} ${color.dim(summarizeArgs(call.function.arguments))}`,
    );
    const output = await executeTool(
      call.function.name,
      call.function.arguments,
      this.options.toolContext,
    );
    const firstLine = output.split("\n", 1)[0] ?? "";
    console.log(
      color.dim(
        `  ↳ ${firstLine.slice(0, 120)}${output.includes("\n") || firstLine.length > 120 ? " …" : ""}`,
      ),
    );
    return output;
  }

  /**
   * One streamed completion, failing over to the next-best free model when
   * the current one errors in a retryable way.
   */
  private async completeWithFailover(): Promise<CompletionResult> {
    const { scout, client } = this.options;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
      const model = scout.pick();
      if (!model)
        throw new Error("no free tool-calling models are currently available on OpenRouter");

      if (model.id !== this.lastModel) {
        console.log(color.dim(`● model: ${model.id}`));
        this.lastModel = model.id;
      }

      this.spinner.start(`waiting for ${model.id}`);
      let firstToken = true;
      try {
        const result = await client.chat(
          { model: model.id, messages: this.messages, tools: toolDefinitions },
          (text) => {
            if (firstToken) {
              this.spinner.stop();
              firstToken = false;
            }
            process.stdout.write(text);
          },
        );
        this.spinner.stop();
        if (!firstToken) process.stdout.write("\n");
        return result;
      } catch (err) {
        this.spinner.stop();
        if (!firstToken) process.stdout.write("\n");
        lastError = err;

        if (err instanceof ApiError && err.retryable && !scout.isPinned) {
          if (isDailyLimit(err)) throw err; // account-wide; switching models won't help
          const cooldown = err.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS;
          scout.demote(model.id, cooldown);
          console.log(
            color.yellow(
              `⚠ ${model.id} failed (${err.status}: ${err.message.slice(0, 120)}); trying next model`,
            ),
          );
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all candidate models failed");
  }
}

/** The free-model daily cap applies account-wide, not per model. */
function isDailyLimit(err: ApiError): boolean {
  return err.status === 429 && /per.day|daily/i.test(err.message);
}

function summarizeArgs(rawArgs: string): string {
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const parts = Object.entries(args).map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      const flat = text.replace(/\s+/g, " ");
      return `${k}=${flat.length > 80 ? flat.slice(0, 80) + "…" : flat}`;
    });
    return parts.join(" ");
  } catch {
    return rawArgs.slice(0, 80);
  }
}
