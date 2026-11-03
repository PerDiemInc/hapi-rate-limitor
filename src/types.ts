import type { Lifecycle, Request, ResponseToolkit, Server } from "@hapi/hapi";

export interface Limit {
  /** Requests allowed per `duration`. */
  max: number;
  /** Window length in milliseconds. */
  duration: number;
  /** Once exceeded, keep rejecting for this many milliseconds. */
  blockMs?: number;
  /** Count rejected requests too, so a client stays limited until it backs off. */
  countRejected?: boolean;
  /**
   * Counts by this value instead of the client, like a phone number or store id. The
   * value is hashed before storage. Return nothing to count by the client. Needs an
   * extension point where the value exists: the payload is parsed from `onPostAuth` on.
   */
  by?: (request: Request) => MaybePromise<string | number | undefined | null>;
}

export interface AuthFailureLimit {
  /** Failed attempts allowed per `duration`. */
  max: number;
  /** Window length in milliseconds. */
  duration: number;
  /** Response codes that count as a failed attempt. Defaults to `[401]`. */
  statusCodes?: number[];
}

export type StoreErrorPolicy = "local" | "open" | "closed";

export interface ConsumeOptions {
  /** What is being counted, like `sms:country:US`. Hashed before storage. */
  key: string;
  limits: Array<Omit<Limit, "by">>;
  onStoreError?: StoreErrorPolicy;
  /** Check the budget without counting, for example before paying for a phone lookup. */
  peek?: boolean;
}

/** Exposed on `server.plugins['hapi-rate-limitor']`. */
export interface RateLimitApi {
  /** Counts one event outside the request lifecycle, like a text message about to be sent. */
  consume: (options: ConsumeOptions) => Promise<RateLimit | null>;
}

export interface RouteOptions extends Partial<Omit<Limit, "by">> {
  enabled?: boolean;
  /** Overrides the plugin's `getRouteKey` for this route. */
  getRouteKey?: (request: Request) => MaybePromise<string | undefined | null>;
  /** Several limits, applied all-or-nothing. Takes precedence over `max` and `duration`. */
  limits?: Limit[];
  onStoreError?: StoreErrorPolicy;
  authFailures?: AuthFailureLimit;
}

export type MaybePromise<T> = T | Promise<T>;

export type ClientIpSource =
  | {
      /** Header holding the client's address. */
      header: string;
      /** Set for headers formatted as `ip:port`, where IPv6 has no brackets. */
      hasPort?: boolean;
      /** Honor this source only when it returns true. */
      when?: (request: Request) => MaybePromise<boolean>;
    }
  | {
      /** Number of proxies you control that append to `X-Forwarded-For`. */
      forwardedForHops: number;
      when?: (request: Request) => MaybePromise<boolean>;
    };

/** The subset of an ioredis client or cluster this plugin needs. */
export interface RedisClient {
  defineCommand: (name: string, definition: { lua: string }) => void;
}

export interface PluginOptions extends Partial<Omit<Limit, "by">> {
  enabled?: boolean;
  /** An ioredis client or cluster. You own its connection and its lifecycle. */
  redis: RedisClient;
  namespace?: string;
  extensionPoint?: "onPreAuth" | "onCredentials" | "onPostAuth" | "onPreHandler";
  /** Credentials property identifying a user. */
  userAttribute?: string;
  /** Credentials property holding a user's own `max`. */
  userLimitAttribute?: string;
  /** Key under `route.options.plugins` holding route options. */
  routeOptionKey?: string;
  /** Where to read the client address from, in order. The socket address is the last resort. */
  ipSources?: ClientIpSource[];
  /** Replaces `ipSources`. A falsy result falls back to the socket address. */
  getIp?: (request: Request) => MaybePromise<string | undefined | null>;
  /** IP addresses or CIDR ranges that skip rate limiting. */
  allowlist?: string[];
  skip?: (request: Request) => MaybePromise<boolean>;
  /** Identifies the counter for routes with their own limit. Defaults to method and path template. */
  getRouteKey?: (request: Request) => MaybePromise<string | undefined | null>;
  emitter?: { emit: (event: string, ...args: unknown[]) => unknown };
  /** Builds the response when a limit is exceeded. Defaults to a 429 error. */
  onExceeded?: (
    request: Request,
    h: ResponseToolkit,
    rateLimit: RateLimit,
  ) => MaybePromise<Lifecycle.ReturnValue>;
  /** What to do when Redis fails. Defaults to `local`: limit per server process in memory. */
  onStoreError?: StoreErrorPolicy;
  /** How long a request may wait for Redis. */
  storeTimeoutMs?: number;
  /** Remember rejected clients in memory so attack traffic doesn't reach Redis. */
  shield?: boolean;
  /**
   * Limit by client IP before routing, authentication and body parsing, so requests that
   * fail those steps still count. Route options don't exist yet at this point, so use
   * `skip` to exempt paths like health checks. `getIp` runs before authentication here.
   */
  earlyLimit?: Pick<Limit, "max" | "duration" | "blockMs">;
  /** Limit failed authentication attempts per client IP on every route. */
  authFailures?: AuthFailureLimit;
}

export interface RateLimit {
  /** Requests allowed in the window. */
  total: number;
  /** Requests left in the window. */
  remaining: number;
  /** Time since epoch, in seconds, when the window fully resets. */
  reset: number;
  /** Seconds until a request can succeed. `0` when in quota. */
  retryAfter: number;
  isInQuota: () => boolean;
}

export interface Decision {
  allowed: boolean;
  total: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
}

export interface LimitKey {
  logKey: string;
  blockKey: string;
  limit: Limit;
}

export type StoreMode = "hit" | "peek";

export interface Store {
  consume: (keys: LimitKey[], mode: StoreMode, member?: string) => Promise<Decision>;
  /** Removes a request counted under `member`, like a login that turned out to succeed. */
  release: (keys: LimitKey[], member: string) => Promise<void>;
}

export type { Request, ResponseToolkit, Server };
