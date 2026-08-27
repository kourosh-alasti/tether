/**
 * Vercel AI Gateway client powered by the Vercel AI SDK.
 *
 * Tether only admits Gateway models that are explicitly synthetic free-tier
 * variants. The checks intentionally overlap (id, tag, and zero catalog
 * pricing) so a catalog shape change fails closed instead of selecting a paid
 * model.
 */

import { createGateway, jsonSchema, ModelMessage, streamText, tool, ToolSet } from "ai";

import { ApiError, ChatMessage, CompletionResult, ToolCall, ToolDefinition } from "./openrouter.js";

const CATALOG_URL = process.env.VERCEL_AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";

export interface VercelModelInfo {
  id: string;
  name: string;
  created?: number;
  released?: number;
  context_window?: number;
  type?: string;
  tags?: string[];
  supported_parameters?: string[];
  pricing?: Record<string, unknown>;
}

export class VercelClient {
  readonly provider = "vercel" as const;
  private gateway;

  constructor(private apiKey?: string) {
    this.gateway = createGateway({ apiKey: apiKey ?? "" });
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  async listFreeModels(): Promise<VercelModelInfo[]> {
    const response = await fetch(`${CATALOG_URL}/models`, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
    });
    if (!response.ok) {
      throw new ApiError(
        `Vercel AI Gateway model catalog failed: ${response.status} ${await response.text()}`,
        response.status,
      );
    }
    const body = (await response.json()) as { data?: VercelModelInfo[] };
    return (body.data ?? []).filter(isFreeToolCallingModel);
  }

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
      throw new ApiError("No Vercel AI Gateway key configured. Run `tether login vercel`.", 401);
    }

    // Never trust a caller-supplied paid model id. Synthetic free-tier ids are
    // unambiguously suffixed by Vercel and are revalidated during discovery.
    if (!options.model.endsWith("-free")) {
      throw new ApiError(`Refusing non-free Vercel model "${options.model}"`, 400);
    }

    const tools = Object.fromEntries(
      (options.tools ?? []).map((definition) => [
        definition.function.name,
        tool({
          description: definition.function.description,
          inputSchema: jsonSchema(definition.function.parameters),
        }),
      ]),
    ) satisfies ToolSet;

    try {
      const result = streamText({
        model: this.gateway(options.model),
        messages: toModelMessages(options.messages),
        tools,
        abortSignal: options.signal,
        maxRetries: 0,
      });

      let content = "";
      const toolCalls: ToolCall[] = [];
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          content += part.text;
          onDelta?.(part.text);
        } else if (part.type === "tool-call") {
          toolCalls.push({
            id: part.toolCallId,
            type: "function",
            function: { name: part.toolName, arguments: JSON.stringify(part.input) },
          });
        } else if (part.type === "error") {
          throw part.error;
        }
      }

      return {
        content,
        toolCalls,
        finishReason: await result.finishReason,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const candidate = error as {
        statusCode?: unknown;
        responseBody?: unknown;
        message?: unknown;
      };
      const status = typeof candidate.statusCode === "number" ? candidate.statusCode : 502;
      const message =
        typeof candidate.message === "string"
          ? candidate.message
          : typeof candidate.responseBody === "string"
            ? candidate.responseBody
            : String(error);
      throw new ApiError(message, status);
    }
  }
}

function isFreeToolCallingModel(model: VercelModelInfo): boolean {
  const pricing = model.pricing ?? {};
  const zeroPriced =
    isZeroPrice(pricing.input) &&
    isZeroPrice(pricing.output) &&
    Object.values(pricing).every(containsOnlyZeroPrices);
  return (
    model.id.endsWith("-free") &&
    model.tags?.includes("free") === true &&
    model.type === "language" &&
    model.supported_parameters?.includes("tools") === true &&
    zeroPriced
  );
}

function containsOnlyZeroPrices(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "number" || typeof value === "string") return Number(value) === 0;
  if (Array.isArray(value)) return value.every(containsOnlyZeroPrices);
  if (typeof value === "object") {
    return Object.entries(value).every(
      ([key, nested]) =>
        // Tier boundaries describe token counts, not prices.
        key === "min" || key === "max" || containsOnlyZeroPrices(nested),
    );
  }
  return false;
}

function isZeroPrice(value: unknown): boolean {
  return (typeof value === "number" || typeof value === "string") && Number(value) === 0;
}

function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const toolNames = new Map<string, string>();

  return messages.map((message): ModelMessage => {
    if (message.role === "system" || message.role === "user") return message;
    if (message.role === "assistant") {
      const content: NonNullable<Extract<ModelMessage, { role: "assistant" }>["content"]> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name);
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.function.name,
          input: parseToolInput(call.function.arguments),
        });
      }
      return { role: "assistant", content };
    }

    if (message.role !== "tool") {
      throw new Error(`Unsupported message role: ${message.role}`);
    }
    const toolName = message.name ?? toolNames.get(message.tool_call_id);
    if (!toolName) throw new Error(`Could not match tool result ${message.tool_call_id}`);
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: message.tool_call_id,
          toolName,
          output: { type: "text", value: message.content },
        },
      ],
    };
  });
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
