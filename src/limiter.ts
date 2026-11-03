import type { Decision, LimitKey, Store, StoreErrorPolicy, StoreMode } from "./types";

const FAILURES_BEFORE_OPEN = 5;
const CIRCUIT_COOLDOWN_MS = 1_000;
const MAX_SHIELDED_KEYS = 10_000;

export class StoreUnavailableError extends Error {
  constructor() {
    super("The rate limit store is unavailable");
    this.name = "StoreUnavailableError";
  }
}

interface LimiterConfig {
  primary: Store;
  fallback: Store;
  timeoutMs: number;
  shield: boolean;
  onStoreError: (error: unknown) => void;
}

/** Puts the safety features around the store: shield, timeout, circuit breaker and fallback. */
export class Limiter {
  private readonly shielded = new Map<string, { decision: Decision; expiresAt: number }>();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private probing = false;

  constructor(private readonly config: LimiterConfig) {}

  /** Returns `null` when the store failed and the policy is to let the request through. */
  async decide(
    keys: LimitKey[],
    mode: StoreMode,
    policy: StoreErrorPolicy,
    { member, shield = this.config.shield }: { member?: string; shield?: boolean } = {},
  ): Promise<Decision | null> {
    const canShield = shield && mode === "hit" && keys.every(({ limit }) => !limit.countRejected);
    const shieldKey = keys.map((key) => key.logKey).join("|");

    if (canShield) {
      const shielded = this.readShield(shieldKey);

      if (shielded) {
        return shielded;
      }
    }

    if (Date.now() < this.circuitOpenUntil || this.probing) {
      return this.applyPolicy(keys, mode, policy, member);
    }

    // After the cooldown one request tests the store, so the rest don't wait on it too.
    const isProbe = this.consecutiveFailures >= FAILURES_BEFORE_OPEN;

    this.probing = isProbe;

    try {
      const decision = await this.withTimeout(this.config.primary.consume(keys, mode, member));

      this.consecutiveFailures = 0;

      if (canShield && !decision.allowed) {
        this.writeShield(shieldKey, decision);
      }

      return decision;
    } catch (error) {
      this.recordFailure(error);

      return this.applyPolicy(keys, mode, policy, member);
    } finally {
      if (isProbe) {
        this.probing = false;
      }
    }
  }

  /** Undoes a count. Best effort: if it fails, the entry ages out with its window. */
  async release(keys: LimitKey[], member: string): Promise<void> {
    await this.config.fallback.release(keys, member);

    if (Date.now() >= this.circuitOpenUntil) {
      await this.withTimeout(this.config.primary.release(keys, member)).catch(() => {});
    }
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= FAILURES_BEFORE_OPEN) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    }

    this.config.onStoreError(error);
  }

  private async applyPolicy(
    keys: LimitKey[],
    mode: StoreMode,
    policy: StoreErrorPolicy,
    member?: string,
  ): Promise<Decision | null> {
    if (policy === "closed") {
      throw new StoreUnavailableError();
    }

    return policy === "open" ? null : this.config.fallback.consume(keys, mode, member);
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Rate limit store timed out after ${this.config.timeoutMs}ms`)),
        this.config.timeoutMs,
      );
    });

    // A late rejection must not surface as an unhandled rejection after the timeout wins.
    operation.catch(() => {});

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private readShield(key: string): Decision | undefined {
    const entry = this.shielded.get(key);

    if (!entry) {
      return undefined;
    }

    const retryAfterMs = entry.expiresAt - Date.now();

    if (retryAfterMs <= 0) {
      this.shielded.delete(key);

      return undefined;
    }

    return { ...entry.decision, retryAfterMs };
  }

  private writeShield(key: string, decision: Decision): void {
    this.shielded.delete(key);
    this.shielded.set(key, { decision, expiresAt: Date.now() + decision.retryAfterMs });

    if (this.shielded.size > MAX_SHIELDED_KEYS) {
      this.shielded.delete(this.shielded.keys().next().value as string);
    }
  }
}
