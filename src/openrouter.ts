/**
 * Minimal OpenRouter API client (no dependencies, native fetch).
 *
 * Endpoints used:
 *   GET  /api/v1/models            — public model catalog (no key required)
 *   POST /api/v1/chat/completions  — OpenAI-compatible chat with tool calling
 */

const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

// Identify the app to OpenRouter (used for their public leaderboards, optional).
const APP_HEADERS = {
  "HTTP-Referer": "https://github.com/tether-cli/tether",
  "X-Title": "tether",
};

export interface ModelInfo {
  id: string;
  name: string;
  created: number;
  context_length: number | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    [key: string]: string | undefined;
  };
  supported_parameters?: string[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when a different model (or a later retry) could plausibly succeed. */
  get retryable(): boolean {
    return (
      this.status === 402 || // provider requires payment / out of quota
      this.status === 404 || // no endpoints currently serving this model
      this.status === 408 ||
      this.status === 429 ||
      this.status >= 500
    );
  }
}

export class OpenRouterClient {
  constructor(private apiKey?: string) {}

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  async listModels(params?: {
    category?: string;
    supported_parameters?: string;
    sort?: string;
  }): Promise<ModelInfo[]> {
    const url = new URL(`${BASE_URL}/models`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const res = await fetch(url, { headers: { ...APP_HEADERS } });
    if (!res.ok) {
      throw new ApiError(`GET /models failed: ${res.status} ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as { data: ModelInfo[] };
    return body.data;
  }

  /**
   * Streaming chat completion. Emits content tokens through `onDelta` as they
   * arrive and returns the assembled message (content + tool calls) at the end.
   */
  async chat(
    options: {
      model: string;
      messages: ChatMessage[];
      tools?: ToolDefinition[];
      signal?: AbortSignal;
    },
    onDelta?: (text: string) => void,
  ): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new ApiError("No API key configured. Set OPENROUTER_API_KEY.", 401);
    }
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...APP_HEADERS,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        tools: options.tools,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new ApiError(
        extractErrorMessage(text) ?? `chat completion failed with status ${res.status}`,
        res.status,
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }

    return this.consumeStream(res.body, onDelta);
  }

  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    onDelta?: (text: string) => void,
  ): Promise<CompletionResult> {
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    // Tool-call deltas arrive keyed by index and must be assembled.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data: ")) continue; // ignore comments / keep-alives
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // partial or malformed frame
        }
        // OpenRouter reports mid-stream failures as an error event.
        if (chunk.error) {
          throw new ApiError(
            chunk.error.message ?? "provider error mid-stream",
            Number(chunk.error.code) || 502,
          );
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? 0;
          const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          toolCalls.set(index, entry);
        }
      }
    }

    return {
      content,
      finishReason,
      toolCalls: [...toolCalls.entries()]
        .toSorted(([a], [b]) => a - b)
        .map(([i, tc]) => ({
          id: tc.id || `call_${i}`,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        })),
    };
  }
}

function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message ?? parsed?.message;
  } catch {
    return body.length > 0 && body.length < 500 ? body : undefined;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
