import type { Decision, LimitKey, Store, StoreMode } from "../types";

const DEFAULT_MAX_KEYS = 50_000;

interface Hit {
  at: number;
  member?: string;
}

interface Entry {
  hits: Hit[];
  blockedUntil: number;
  expiresAt: number;
}

/**
 * In-process limiter used while Redis is unavailable. It mirrors the Redis script's
 * rules, but each server process counts on its own. Least recently used keys are
 * evicted, so an attacker rotating identities can't exhaust memory.
 */
export class MemoryStore implements Store {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxKeys = DEFAULT_MAX_KEYS) {}

  async release(keys: LimitKey[], member: string): Promise<void> {
    for (const { logKey } of keys) {
      const hits = this.entries.get(logKey)?.hits;
      const index = hits?.findIndex((hit) => hit.member === member) ?? -1;

      if (index !== -1) {
        hits?.splice(index, 1);
      }
    }
  }

  async consume(keys: LimitKey[], mode: StoreMode, member?: string): Promise<Decision> {
    const now = Date.now();
    const states = keys.map(({ logKey, limit }) => {
      const entry = this.touch(logKey, limit.duration, now);
      const blockedMs = Math.max(0, entry.blockedUntil - now);

      return { entry, limit, blockedMs, rejected: entry.hits.length >= limit.max || blockedMs > 0 };
    });
    const allowed = states.every((state) => !state.rejected);

    if (mode === "hit") {
      for (const state of states) {
        const { entry, limit } = state;

        if (allowed || limit.countRejected) {
          entry.hits.push({ at: now, member });
          entry.hits.splice(0, Math.max(0, entry.hits.length - limit.max));
          entry.expiresAt = now + Math.max(limit.duration, limit.blockMs ?? 0);
        }

        if (!allowed && state.rejected && limit.blockMs && state.blockedMs === 0) {
          entry.blockedUntil = now + limit.blockMs;
          entry.expiresAt = Math.max(entry.expiresAt, entry.blockedUntil);
          state.blockedMs = limit.blockMs;
        }
      }
    }

    const results = states.map(({ entry, limit, blockedMs, rejected }) => {
      const windowResetAt = (entry.hits[0]?.at ?? now) + limit.duration;
      const windowRetryMs = entry.hits.length >= limit.max ? windowResetAt - now : 0;

      return {
        rejected,
        total: limit.max,
        remaining: blockedMs > 0 ? 0 : Math.max(0, limit.max - entry.hits.length),
        resetAt: Math.max(windowResetAt, now + blockedMs),
        retryAfterMs: rejected ? Math.max(1, blockedMs, windowRetryMs) : 0,
      };
    });

    return pickDecision(results, allowed);
  }

  private touch(key: string, duration: number, now: number): Entry {
    const existing = this.entries.get(key);
    const entry =
      existing && existing.expiresAt > now
        ? existing
        : { hits: [], blockedUntil: 0, expiresAt: now + duration };

    const windowStart = now - duration;
    const firstLive = entry.hits.findIndex((hit) => hit.at > windowStart);

    entry.hits.splice(0, firstLive === -1 ? entry.hits.length : firstLive);

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict();

    return entry;
  }

  private evict(): void {
    while (this.entries.size > this.maxKeys) {
      const { value: oldest } = this.entries.keys().next();

      this.entries.delete(oldest as string);
    }
  }
}

interface LimitResult {
  rejected: boolean;
  total: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
}

/** When rejected, reports the limit blocking longest; otherwise the one closest to its limit. */
function pickDecision(results: LimitResult[], allowed: boolean): Decision {
  const chosen = results.reduce((best, result) => {
    if (allowed) {
      return result.remaining < best.remaining ? result : best;
    }

    if (result.rejected !== best.rejected) {
      return result.rejected ? result : best;
    }

    return result.retryAfterMs > best.retryAfterMs ? result : best;
  });

  return {
    allowed,
    total: chosen.total,
    remaining: chosen.remaining,
    resetAt: chosen.resetAt,
    retryAfterMs: chosen.retryAfterMs,
  };
}
