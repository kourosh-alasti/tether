/**
 * Model scout: figures out the best *free* model for coding right now, and
 * keeps that answer fresh by polling OpenRouter on a schedule.
 *
 * Ranking is fully data-driven (no hardcoded model names, which would go
 * stale within weeks). Two public catalog queries are cross-referenced:
 *
 *   1. `?supported_parameters=tools`          — every model that can do tool
 *      calling; we keep the `:free` variants with all-zero pricing.
 *   2. `?category=programming&sort=top-weekly` — OpenRouter's own ranking of
 *      coding models by tokens processed this week (mostly paid base slugs).
 *
 * A free model whose base slug (id minus `:free`) appears in the programming
 * ranking inherits that position. Free models outside the ranking come after,
 * ordered by context length, then recency.
 */

import { ModelInfo, OpenRouterClient } from "./openrouter.js";

export interface RankedModel {
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
  return Object.values(pricing).every((v) => v === undefined || Number(v) === 0);
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

export class ModelScout {
  private ranking: RankedModel[] = [];
  private cooldownUntil = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(
    private client: OpenRouterClient,
    /** Pin to one model and skip scouting entirely. */
    private pinnedModel?: string,
  ) {}

  get models(): readonly RankedModel[] {
    return this.ranking;
  }

  get isPinned(): boolean {
    return Boolean(this.pinnedModel);
  }

  /** Pin a model id from now on; stops polling and disables failover. */
  pin(id: string): void {
    this.stopPolling();
    this.pinnedModel = id;
  }

  /** Resume automatic model selection after a model was pinned. */
  useAutomatic(): void {
    this.pinnedModel = undefined;
  }

  async refresh(): Promise<void> {
    // Coalesce concurrent refreshes (timer tick during a manual refresh).
    this.refreshing ??= this.doRefresh();
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      this.ranking = await rankFreeCodingModels(this.client);
    } finally {
      this.refreshing = undefined;
    }
  }

  /**
   * Re-poll the catalog every `intervalMs`. `onChange` fires when the best
   * pick differs from the previous poll.
   */
  startPolling(intervalMs: number, onChange?: (best: RankedModel) => void): void {
    if (this.pinnedModel || this.timer) return;
    this.timer = setInterval(async () => {
      const before = this.pick();
      try {
        await this.refresh();
      } catch {
        return; // transient catalog failure; keep the last known ranking
      }
      const after = this.pick();
      if (after && after.id !== before?.id) onChange?.(after);
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Best model right now: highest-ranked one that is not cooling down. */
  pick(excluded: ReadonlySet<string> = new Set()): RankedModel | undefined {
    if (this.pinnedModel) {
      if (excluded.has(this.pinnedModel)) return undefined;
      return { id: this.pinnedModel, name: this.pinnedModel, contextLength: 0, created: 0 };
    }
    const now = Date.now();
    const candidates = this.ranking.filter((model) => !excluded.has(model.id));
    return (
      candidates.find((model) => (this.cooldownUntil.get(model.id) ?? 0) <= now) ?? candidates[0]
    );
  }

  /** Bench a model that failed (rate limit, dead endpoint, ...) for a while. */
  demote(id: string, seconds: number): void {
    this.cooldownUntil.set(id, Date.now() + seconds * 1000);
  }

  cooldownRemaining(id: string): number {
    return Math.max(0, (this.cooldownUntil.get(id) ?? 0) - Date.now()) / 1000;
  }
}
