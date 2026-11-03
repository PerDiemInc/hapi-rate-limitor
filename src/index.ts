import { createHash, randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type {
  Lifecycle,
  Plugin,
  Request,
  ResponseObject,
  ResponseToolkit,
  Server,
} from "@hapi/hapi";
import {
  DEFAULT_IP_SOURCES,
  parseAddress,
  resolveClientIp,
  toRateLimitIdentity,
} from "./client-ip";
import { Limiter, StoreUnavailableError } from "./limiter";
import { assertLimit, assertPluginOptions, assertRouteOptions, readRouteLimits } from "./options";
import { MemoryStore } from "./store/memory";
import { isRedisClient, RedisStore } from "./store/redis";
import type {
  ConsumeOptions,
  Decision,
  Limit,
  LimitKey,
  PluginOptions,
  RateLimit,
  RateLimitApi,
  RouteOptions,
} from "./types";

export type * from "./types";

declare module "@hapi/hapi" {
  interface Request {
    rateLimit?: RateLimit;
  }
}

const EVENTS = {
  attempt: "rate-limit:attempt",
  inQuota: "rate-limit:in-quota",
  exceeded: "rate-limit:exceeded",
  storeError: "rate-limit:store-error",
} as const;

const MAX_IDENTITY_LENGTH = 128;
const DEFAULT_MAX = 60;
const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_STORE_TIMEOUT_MS = 250;
const DEFAULT_AUTH_FAILURE_CODES = [401];
const STORE_RETRY_AFTER_SECONDS = 1;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Keeps keys bounded and clear of Redis hash tag syntax, whatever a client sends. Encoding
 * `%` and `:` means the parts of a key can't run together and match another client's key.
 */
function safeKeyPart(value: string): string {
  return value.length > MAX_IDENTITY_LENGTH || /[{}\s]/.test(value)
    ? `sha256-${sha256(value)}`
    : value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

function buildAllowlist(entries: string[]): BlockList {
  const list = new BlockList();

  for (const entry of entries) {
    const [address = "", prefix, ...extra] = entry.split("/");
    const version = isIP(address);
    const validPrefix =
      prefix === undefined ||
      (/^\d+$/.test(prefix) && Number(prefix) <= (version === 6 ? 128 : 32));

    // An empty prefix would otherwise parse as /0 and exempt every client.
    if (version === 0 || !validPrefix || extra.length > 0) {
      throw new Error(
        `hapi-rate-limitor: allowlist entry "${entry}" is not an IP address or CIDR range`,
      );
    }

    const family = version === 6 ? "ipv6" : "ipv4";

    if (prefix === undefined) {
      list.addAddress(address, family);
    } else {
      list.addSubnet(address, Number(prefix), family);
    }
  }

  return list;
}

function toRateLimit(decision: Decision): RateLimit {
  return {
    total: decision.total,
    remaining: decision.remaining,
    reset: Math.ceil(decision.resetAt / 1000),
    retryAfter: Math.ceil(decision.retryAfterMs / 1000),
    isInQuota: () => decision.allowed,
  };
}

interface ErrorLikeResponse {
  isBoom?: boolean;
  statusCode?: number;
  output?: { statusCode: number; headers: Record<string, string | number> };
  header?: (name: string, value: string) => unknown;
}

function setHeader(response: ErrorLikeResponse, name: string, value: number): void {
  if (response.isBoom && response.output) {
    response.output.headers[name] = value;
  } else {
    response.header?.(name, String(value));
  }
}

function setRateLimitHeaders(request: Request, rateLimit: RateLimit): void {
  const response = request.response as unknown as ErrorLikeResponse | null;

  if (!response) {
    return;
  }

  setHeader(response, "X-Rate-Limit-Limit", rateLimit.total);
  setHeader(response, "X-Rate-Limit-Remaining", rateLimit.remaining);
  setHeader(response, "X-Rate-Limit-Reset", rateLimit.reset);

  if (rateLimit.retryAfter > 0) {
    setHeader(response, "Retry-After", rateLimit.retryAfter);
  }
}

function statusCodeOf(request: Request): number | undefined {
  const response = request.response as unknown as ErrorLikeResponse | null;

  return response?.isBoom ? response.output?.statusCode : response?.statusCode;
}

function errorResponse(
  h: ResponseToolkit,
  statusCode: number,
  error: string,
  message: string,
): ResponseObject {
  return h.response({ statusCode, error, message }).code(statusCode);
}

const register = async (server: Server, options: PluginOptions): Promise<void> => {
  if (options?.enabled === false) {
    // Callers of `consume` shouldn't need to know whether the plugin is on.
    server.expose("consume", async () => null);

    return;
  }

  assertPluginOptions(options ?? {});

  if (!isRedisClient(options?.redis)) {
    throw new Error("hapi-rate-limitor: redis must be an ioredis client or cluster");
  }

  const {
    redis,
    namespace = "rate-limit",
    extensionPoint = "onPostAuth",
    userAttribute = "id",
    userLimitAttribute = "rateLimit",
    routeOptionKey = "hapi-rate-limitor",
    ipSources = DEFAULT_IP_SOURCES,
    getIp,
    allowlist = [],
    skip,
    getRouteKey,
    emitter,
    onExceeded,
    onStoreError: defaultPolicy = "local",
    storeTimeoutMs = DEFAULT_STORE_TIMEOUT_MS,
    shield = true,
    authFailures: defaultAuthFailures,
    earlyLimit,
  } = options;

  const defaultLimit: Limit = {
    max: options.max ?? DEFAULT_MAX,
    duration: options.duration ?? DEFAULT_DURATION_MS,
    blockMs: options.blockMs,
    countRejected: options.countRejected,
  };

  const allowedIps = buildAllowlist(allowlist);

  if (allowlist.length > 0 && !getIp && ipSources.some((source) => !source.when)) {
    server.log(
      ["warn", "rate-limit"],
      "allowlist relies on an unguarded IP source. A client that can set that header can skip rate limiting.",
    );
  }

  if (!emitter) {
    for (const name of Object.values(EVENTS)) {
      server.event(name);
    }
  }

  const emit = async (name: string, payload: unknown): Promise<void> => {
    try {
      await (emitter ?? server.events).emit(name, payload);
    } catch (error) {
      server.log(
        ["error", "rate-limit"],
        error instanceof Error ? error.message : "A rate limit event listener failed",
      );
    }
  };

  const limiter = new Limiter({
    primary: new RedisStore(redis),
    fallback: new MemoryStore(),
    timeoutMs: storeTimeoutMs,
    shield,
    onStoreError: (error) => {
      server.log(
        ["warn", "rate-limit"],
        error instanceof Error ? error.message : "The rate limit store failed",
      );
      void emit(EVENTS.storeError, error);
    },
  });

  const routeOptionsOf = (request: Request): RouteOptions => {
    return (
      (request.route.settings.plugins as Record<string, RouteOptions | undefined>)[
        routeOptionKey
      ] ?? {}
    );
  };

  // Not cached across lifecycle steps, because a resolver can depend on authentication.
  const clientIp = async (request: Request): Promise<string> => {
    const custom = getIp ? await getIp(request) : undefined;

    if (custom) {
      return parseAddress(String(custom)) ?? String(custom);
    }

    const resolved = getIp
      ? parseAddress(request.info.remoteAddress)
      : await resolveClientIp(request, ipSources);

    return resolved ?? "unknown";
  };

  const isExempt = async (request: Request, ip: string): Promise<boolean> => {
    const version = isIP(ip);
    const allowlisted =
      allowlist.length > 0 &&
      version !== 0 &&
      allowedIps.check(ip, version === 6 ? "ipv6" : "ipv4");

    return allowlisted || Boolean(await skip?.(request));
  };

  const ipIdentity = (ip: string): string => `ip:${isIP(ip) ? toRateLimitIdentity(ip) : ip}`;

  const clientIdentity = (request: Request, ip: string): string => {
    const credentials = request.auth.credentials as Record<string, unknown> | null | undefined;
    const userId = credentials?.[userAttribute];

    return userId === undefined || userId === null || userId === ""
      ? ipIdentity(ip)
      : `user:${String(userId)}`;
  };

  const routeKey = async (request: Request): Promise<string> => {
    const custom = await (routeOptionsOf(request).getRouteKey ?? getRouteKey)?.(request);

    if (custom !== undefined && custom !== null) {
      return String(custom);
    }

    const { method, vhost, path } = request.route;

    return [method, vhost, path].filter(Boolean).join(":");
  };

  /**
   * Limits of one request must share a Redis Cluster slot to apply atomically. Limits
   * keyed by `by` are counted across clients, so those routes share a slot per route.
   */
  const buildKeys = async (
    request: Request,
    identity: string,
    scope: string,
    limits: Limit[],
  ): Promise<LimitKey[]> => {
    const safeScope = safeKeyPart(scope);
    const usesBy = limits.some((limit) => limit.by);
    const tag = safeKeyPart(usesBy ? scope : identity);

    return Promise.all(
      limits.map(async (limit, index) => {
        const value = await limit.by?.(request);
        const hasValue = value !== undefined && value !== null && value !== "";
        // Hashed, because these values are often phone numbers or emails.
        const subject = hasValue ? `by:${sha256(String(value))}` : safeKeyPart(identity);
        const logKey = `${namespace}:{${tag}}:${safeScope}:${index}:${subject}`;

        return { logKey, blockKey: `${logKey}:blocked`, limit };
      }),
    );
  };

  /** A user's own limit beats the plugin default. A route's own limit beats both. */
  const plan = async (
    request: Request,
    route: RouteOptions,
  ): Promise<{ limits: Limit[]; scope: string }> => {
    const routeLimits = readRouteLimits(route, `route ${request.route.path}`);

    if (routeLimits) {
      return { limits: routeLimits, scope: await routeKey(request) };
    }

    const credentials = request.auth.credentials as Record<string, unknown> | null | undefined;
    const userMax = credentials?.[userLimitAttribute];
    const userLimit: Limit = {
      ...defaultLimit,
      ...(Number.isInteger(userMax) && (userMax as number) > 0 ? { max: userMax as number } : {}),
    };

    if (
      route.max === undefined &&
      route.duration === undefined &&
      route.blockMs === undefined &&
      route.countRejected === undefined
    ) {
      return { limits: [userLimit], scope: "global" };
    }

    const routeLimit: Limit = {
      ...userLimit,
      max: route.max ?? userLimit.max,
      duration: route.duration ?? userLimit.duration,
      blockMs: route.blockMs ?? userLimit.blockMs,
      countRejected: route.countRejected ?? userLimit.countRejected,
    };

    assertLimit(routeLimit, `route ${request.route.path}`);

    return { limits: [routeLimit], scope: await routeKey(request) };
  };

  const unavailable = (h: ResponseToolkit): Lifecycle.ReturnValue => {
    return errorResponse(h, 503, "Service Unavailable", "Rate limiting is temporarily unavailable")
      .header("Retry-After", String(STORE_RETRY_AFTER_SECONDS))
      .takeover();
  };

  const rejectedResponse = async (
    request: Request,
    h: ResponseToolkit,
    decision: Decision,
    message: string,
  ): Promise<Lifecycle.ReturnValue> => {
    request.rateLimit = toRateLimit(decision);
    await emit(EVENTS.exceeded, request);

    return errorResponse(h, 429, "Too Many Requests", message).takeover();
  };

  /** Turns a store failure under the `closed` policy into a 503, and rethrows the rest. */
  const unavailableOrThrow = (error: unknown, h: ResponseToolkit): Lifecycle.ReturnValue => {
    if (error instanceof StoreUnavailableError) {
      return unavailable(h);
    }

    throw error;
  };

  const handle: Lifecycle.Method = async (request, h) => {
    const route = routeOptionsOf(request);
    const ip = await clientIp(request);

    if (route.enabled === false || (await isExempt(request, ip))) {
      return h.continue;
    }

    await emit(EVENTS.attempt, request);

    const { limits, scope } = await plan(request, route);
    const keys = await buildKeys(request, clientIdentity(request, ip), scope, limits);
    let decision: Decision | null;

    try {
      decision = await limiter.decide(keys, "hit", route.onStoreError ?? defaultPolicy);
    } catch (error) {
      return unavailableOrThrow(error, h);
    }

    if (!decision) {
      return h.continue;
    }

    request.rateLimit = toRateLimit(decision);

    if (decision.allowed) {
      await emit(EVENTS.inQuota, request);

      return h.continue;
    }

    await emit(EVENTS.exceeded, request);

    if (onExceeded) {
      const response = (await onExceeded(request, h, request.rateLimit)) as unknown as
        | (ResponseObject & { isBoom?: boolean })
        | Error;

      if ((response as { isBoom?: boolean }).isBoom) {
        throw response;
      }

      return typeof (response as ResponseObject).takeover === "function"
        ? (response as ResponseObject).takeover()
        : h
            .response(response as never)
            .code(429)
            .takeover();
    }

    return errorResponse(
      h,
      429,
      "Too Many Requests",
      "You have exceeded the request limit",
    ).takeover();
  };

  server.decorate("request", "rateLimit", undefined as unknown as RateLimit);

  const consume: RateLimitApi["consume"] = async ({
    key,
    limits,
    onStoreError,
    peek,
  }: ConsumeOptions) => {
    if (!Array.isArray(limits) || limits.length === 0) {
      throw new Error("hapi-rate-limitor: consume needs at least one limit");
    }

    for (const limit of limits) {
      assertLimit(limit, "consume");
    }

    const tag = `${namespace}:{event:${sha256(key)}}`;
    const keys = limits.map((limit, index) => {
      const logKey = `${tag}:${index}`;

      return { logKey, blockKey: `${logKey}:blocked`, limit };
    });
    const decision = await limiter.decide(
      keys,
      peek ? "peek" : "hit",
      onStoreError ?? defaultPolicy,
    );

    return decision && toRateLimit(decision);
  };

  server.expose("consume", consume);

  server.ext("onPreStart", async () => {
    for (const route of server.table()) {
      const routeOptions = (route.settings.plugins as Record<string, RouteOptions | undefined>)[
        routeOptionKey
      ];

      if (routeOptions) {
        assertRouteOptions(routeOptions, `route ${route.path}`, defaultLimit);
      }
    }
  });

  if (earlyLimit) {
    server.ext("onRequest", async (request, h) => {
      const ip = await clientIp(request);

      if (await isExempt(request, ip)) {
        return h.continue;
      }

      const keys = await buildKeys(request, ipIdentity(ip), "early", [earlyLimit]);

      try {
        const decision = await limiter.decide(keys, "hit", defaultPolicy);

        if (decision && !decision.allowed) {
          return rejectedResponse(request, h, decision, "You have exceeded the request limit");
        }
      } catch (error) {
        return unavailableOrThrow(error, h);
      }

      return h.continue;
    });
  }

  // Each attempt takes a slot before authentication and gives it back if it succeeds.
  // Counting only afterwards would let a burst of parallel guesses all pass the check.
  const authAttempts = new WeakMap<
    Request,
    { keys: LimitKey[]; member: string; statusCodes: number[] }
  >();

  server.ext("onPreAuth", async (request, h) => {
    const route = routeOptionsOf(request);
    const config = route.authFailures ?? defaultAuthFailures;

    if (!config || route.enabled === false) {
      return h.continue;
    }

    const ip = await clientIp(request);

    if (await isExempt(request, ip)) {
      return h.continue;
    }

    const limit: Limit = { max: config.max, duration: config.duration };
    const scope = `auth-failures:${await routeKey(request)}`;
    const keys = await buildKeys(request, ipIdentity(ip), scope, [limit]);
    const member = randomUUID();

    try {
      // Not shielded: a slot can free up as soon as an in-flight login succeeds.
      const decision = await limiter.decide(keys, "hit", route.onStoreError ?? defaultPolicy, {
        member,
        shield: false,
      });

      if (decision && !decision.allowed) {
        return rejectedResponse(request, h, decision, "Too many failed attempts");
      }

      if (decision) {
        authAttempts.set(request, {
          keys,
          member,
          statusCodes: config.statusCodes ?? DEFAULT_AUTH_FAILURE_CODES,
        });
      }
    } catch (error) {
      return unavailableOrThrow(error, h);
    }

    return h.continue;
  });

  server.ext(extensionPoint, handle);

  server.ext("onPreResponse", async (request, h) => {
    const attempt = authAttempts.get(request);
    const statusCode = statusCodeOf(request);

    if (attempt && (statusCode === undefined || !attempt.statusCodes.includes(statusCode))) {
      await limiter.release(attempt.keys, attempt.member);
    }

    if (request.rateLimit) {
      setRateLimitHeaders(request, request.rateLimit);
    }

    return h.continue;
  });
};

export const plugin: Plugin<PluginOptions> = {
  name: "@perdieminc/hapi-rate-limitor",
  once: true,
  register,
};
