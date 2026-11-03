import type {
  AuthFailureLimit,
  Limit,
  PluginOptions,
  RouteOptions,
  StoreErrorPolicy,
} from "./types";

const STORE_ERROR_POLICIES: StoreErrorPolicy[] = ["local", "open", "closed"];
const EXTENSION_POINTS = ["onPreAuth", "onCredentials", "onPostAuth", "onPreHandler"];

const fail = (message: string): never => {
  throw new Error(`hapi-rate-limitor: ${message}`);
};

const isPositiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

export function assertLimit(limit: Partial<Limit>, label: string): asserts limit is Limit {
  if (!isPositiveInteger(limit.max)) {
    fail(`${label}: max must be a positive integer`);
  }

  if (!isPositiveInteger(limit.duration)) {
    fail(`${label}: duration must be a positive integer of milliseconds`);
  }

  if (limit.blockMs !== undefined && !isPositiveInteger(limit.blockMs)) {
    fail(`${label}: blockMs must be a positive integer of milliseconds`);
  }

  if (limit.by !== undefined && typeof limit.by !== "function") {
    fail(`${label}: by must be a function`);
  }
}

function assertPolicy(policy: unknown, label: string): void {
  if (policy !== undefined && !STORE_ERROR_POLICIES.includes(policy as StoreErrorPolicy)) {
    fail(`${label}: onStoreError must be one of ${STORE_ERROR_POLICIES.join(", ")}`);
  }
}

function assertAuthFailures(limit: AuthFailureLimit | undefined, label: string): void {
  if (limit !== undefined) {
    assertLimit(limit, `${label}: authFailures`);

    const { statusCodes } = limit;

    if (
      statusCodes !== undefined &&
      !(Array.isArray(statusCodes) && statusCodes.every(isPositiveInteger))
    ) {
      fail(`${label}: authFailures.statusCodes must be an array of status codes`);
    }
  }
}

function assertFunction(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "function") {
    fail(`${name} must be a function`);
  }
}

export function assertPluginOptions(options: PluginOptions): void {
  assertLimit(
    { max: options.max ?? 60, duration: options.duration ?? 60_000, blockMs: options.blockMs },
    "options",
  );
  assertPolicy(options.onStoreError, "options");
  assertAuthFailures(options.authFailures, "options");

  if (options.earlyLimit !== undefined) {
    assertLimit(options.earlyLimit, "options: earlyLimit");
  }

  if (options.extensionPoint !== undefined && !EXTENSION_POINTS.includes(options.extensionPoint)) {
    fail(`extensionPoint must be one of ${EXTENSION_POINTS.join(", ")}`);
  }

  if (options.storeTimeoutMs !== undefined && !isPositiveInteger(options.storeTimeoutMs)) {
    fail("storeTimeoutMs must be a positive integer of milliseconds");
  }

  for (const name of ["getIp", "skip", "getRouteKey", "onExceeded"] as const) {
    assertFunction(options[name], name);
  }

  for (const source of options.ipSources ?? []) {
    if (
      "forwardedForHops" in source
        ? !isPositiveInteger(source.forwardedForHops)
        : typeof source.header !== "string"
    ) {
      fail("ipSources: each source needs a header name or a positive forwardedForHops");
    }
  }
}

/** Checks a route's options against the plugin defaults it would inherit. */
export function assertRouteOptions(route: RouteOptions, label: string, defaults: Limit): void {
  if (readRouteLimits(route, label) === null) {
    assertLimit(
      {
        max: route.max ?? defaults.max,
        duration: route.duration ?? defaults.duration,
        blockMs: route.blockMs ?? defaults.blockMs,
      },
      label,
    );
  }
}

/** Reads a route's limits, or returns `null` when the route uses the plugin-wide limit. */
export function readRouteLimits(route: RouteOptions, label: string): Limit[] | null {
  assertPolicy(route.onStoreError, label);
  assertAuthFailures(route.authFailures, label);

  if (route.getRouteKey !== undefined && typeof route.getRouteKey !== "function") {
    fail(`${label}: getRouteKey must be a function`);
  }

  if (route.limits) {
    if (!Array.isArray(route.limits) || route.limits.length === 0) {
      fail(`${label}: limits must be a non-empty array`);
    }

    for (const limit of route.limits) {
      assertLimit(limit, label);
    }

    return route.limits;
  }

  return null;
}
