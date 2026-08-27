/**
 * Model scout: figures out the best *free* model for coding right now, and
 * keeps that answer fresh by polling connected providers on a schedule.
 *
 * Ranking is fully data-driven (no hardcoded model names, which would go
 * stale within weeks). Two public catalog queries are cross-referenced:
 *
 *   1. `?supported_parameters=tools`          — every model that can do tool
 *      calling; we keep the `:free` variants with all-zero pricing.
 *   2. `?category=programming&sort=top-weekly` — OpenRouter's own ranking of
 *      coding models by tokens processed this week (mostly paid base slugs).
 *
 * A free OpenRouter model whose base slug (id minus `:free`) appears in the
 * programming ranking inherits that position. Vercel's explicit `-free`
 * tool-calling routes join the same list. Unranked models are ordered by
 * context length, then recency.
 */

import { ModelInfo, OpenRouterClient } from "./openrouter.js";
import { VercelClient } from "./vercel.js";

export type ProviderClient = OpenRouterClient | VercelClient;
export type ProviderName = ProviderClient["provider"];

export interface RankedModel {
  /** Globally unique selector used for pinning, cooldowns, and failover. */
  key: string;
  provider: ProviderName;
  id: string;
  name: string;
  contextLength: number;
  /** Position in OpenRouter's weekly programming ranking, if present. */
  codingRank?: number;
  created: number;
}

export function baseSlug(id: string): string {
  return id.replace(/:[^/]+$/, "");
}

function isZeroPriced(model: ModelInfo): boolean {
  const pricing = model.pricing ?? {};
  return (
    pricing.prompt !== undefined &&
    pricing.completion !== undefined &&
    Number(pricing.prompt) === 0 &&
    Number(pricing.completion) === 0 &&
    Object.values(pricing).every((v) => v === undefined || Number(v) === 0)
  );
}

export async function rankFreeCodingModels(client: OpenRouterClient): Promise<RankedModel[]> {
  // `category` and `supported_parameters` cannot be combined in one query.
  const [toolCapable, programming] = await Promise.all([
    client.listModels({ supported_parameters: "tools" }),
    client.listModels({ category: "programming", sort: "top-weekly" }),
  ]);

  const codingRankBySlug = new Map<string, number>();
  programming.forEach((m, i) => {
    const slug = baseSlug(m.id);
    if (!codingRankBySlug.has(slug)) codingRankBySlug.set(slug, i);
  });

  const free = toolCapable.filter((m) => m.id.endsWith(":free") && isZeroPriced(m));

  const ranked: RankedModel[] = free.map((m) => ({
    key: `openrouter:${m.id}`,
    provider: "openrouter",
    id: m.id,
    name: m.name,
    contextLength: m.context_length ?? 0,
    codingRank: codingRankBySlug.get(baseSlug(m.id)),
    created: m.created,
  }));

  ranked.sort((a, b) => {
    const ar = a.codingRank ?? Number.POSITIVE_INFINITY;
    const br = b.codingRank ?? Number.POSITIVE_INFINITY;
    if (ar !== br) return ar - br;
    if (a.contextLength !== b.contextLength) return b.contextLength - a.contextLength;
    return b.created - a.created;
  });

  return ranked;
}

async function rankVercelFreeModels(client: VercelClient): Promise<RankedModel[]> {
  const models = await client.listFreeModels();
  return models
    .map((model) => ({
      key: `vercel:${model.id}`,
      provider: "vercel" as const,
      id: model.id,
      name: model.name,
      contextLength: model.context_window ?? 0,
      created: model.released ?? model.created ?? 0,
    }))
    .toSorted((a, b) => {
      if (a.contextLength !== b.contextLength) return b.contextLength - a.contextLength;
      return b.created - a.created;
    });
}

export class ModelScout {
  private ranking: RankedModel[] = [];
  private cooldownUntil = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(
    private clients: readonly ProviderClient[],
    /** Requested pin; resolved only after it appears in a verified-free catalog. */
    private requestedModel?: string,
  ) {}

  get models(): readonly RankedModel[] {
    return this.ranking;
  }

  get isPinned(): boolean {
    return Boolean(this.requestedModel);
  }

  /** Pin a model id from now on; stops polling and disables failover. */
  pin(key: string): void {
    if (!this.ranking.some((model) => model.key === key)) {
      throw new Error(`"${key}" is not in the current free-model list`);
    }
    this.stopPolling();
    this.requestedModel = key;
  }

  /** Resume automatic model selection after a model was pinned. */
  useAutomatic(): void {
    this.requestedModel = undefined;
  }

  async refresh(): Promise<void> {
    // Coalesce concurrent refreshes (timer tick during a manual refresh).
    this.refreshing ??= this.doRefresh();
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const results = await Promise.allSettled(
        this.clients.map((client) =>
          client.provider === "openrouter"
            ? rankFreeCodingModels(client)
            : rankVercelFreeModels(client),
        ),
      );
      const rankings = results
        .filter(
          (result): result is PromiseFulfilledResult<RankedModel[]> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);
      if (rankings.length === 0) {
        throw new AggregateError(
          results.map((result) => (result.status === "rejected" ? result.reason : undefined)),
          "Could not load a free-model catalog from any connected provider",
        );
      }
      this.ranking = rankings.flat().toSorted(compareModels);
      if (this.requestedModel) {
        this.requestedModel = resolveSelector(this.requestedModel, this.ranking);
      }
    } finally {
      this.refreshing = undefined;
    }
  }

  /**
   * Re-poll the catalog every `intervalMs`. `onChange` fires when the best
   * pick differs from the previous poll.
   */
  startPolling(intervalMs: number, onChange?: (best: RankedModel) => void): void {
    if (this.requestedModel || this.timer) return;
    this.timer = setInterval(async () => {
      const before = this.pick();
      try {
        await this.refresh();
      } catch {
        return; // transient catalog failure; keep the last known ranking
      }
      const after = this.pick();
      if (after && after.key !== before?.key) onChange?.(after);
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Best model right now: highest-ranked one that is not cooling down. */
  pick(excluded: ReadonlySet<string> = new Set()): RankedModel | undefined {
    if (this.requestedModel) {
      if (excluded.has(this.requestedModel)) return undefined;
      return this.ranking.find((model) => model.key === this.requestedModel);
    }
    const now = Date.now();
    const candidates = this.ranking.filter((model) => !excluded.has(model.key));
    return (
      candidates.find((model) => (this.cooldownUntil.get(model.key) ?? 0) <= now) ?? candidates[0]
    );
  }

  /** Bench a model that failed (rate limit, dead endpoint, ...) for a while. */
  demote(key: string, seconds: number): void {
    this.cooldownUntil.set(key, Date.now() + seconds * 1000);
  }

  cooldownRemaining(key: string): number {
    return Math.max(0, (this.cooldownUntil.get(key) ?? 0) - Date.now()) / 1000;
  }
}

function compareModels(a: RankedModel, b: RankedModel): number {
  const ar = a.codingRank ?? Number.POSITIVE_INFINITY;
  const br = b.codingRank ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  if (a.contextLength !== b.contextLength) return b.contextLength - a.contextLength;
  return b.created - a.created;
}

function resolveSelector(selector: string, models: readonly RankedModel[]): string {
  if (models.some((model) => model.key === selector)) return selector;
  const matches = models.filter((model) => model.id === selector);
  if (matches.length === 1) return matches[0]!.key;
  if (matches.length > 1) {
    throw new Error(
      `Model "${selector}" exists on multiple providers; use ${matches.map((m) => m.key).join(" or ")}`,
    );
  }
  throw new Error(
    `Refusing model "${selector}": it is not in the live, verified-free model catalog`,
  );
}
