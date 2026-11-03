# @perdieminc/hapi-rate-limitor

Rate limiting for [hapi](https://hapi.dev), backed by Redis or Valkey. It has no runtime dependencies, and a Redis outage doesn't take your API down with it.

## What it does

- **Exact sliding windows.** Allows exactly `max` requests in any `duration`, even under concurrent load, across all your servers. It uses Redis' clock, so server clock drift doesn't matter.
- **Stays up when Redis doesn't.** Each request waits at most `storeTimeoutMs`, then the `onStoreError` policy decides what happens. During an outage a circuit breaker lets one request test Redis at a time, so the rest don't wait.
- **Stops SMS pumping and enumeration.** A route can apply several limits at once: per client, per phone number, per number prefix and per store. They're all-or-nothing, so a rejected request spends nothing.
- **Limits failed logins.** `authFailures` locks out a client after repeated 401s, before authentication runs again.
- **Cheap under attack.** Rejected clients are remembered in memory, so a flood doesn't reach Redis.
- **Works on Redis Cluster.** Keys for one request share a slot, and hostile values can't change the key layout.

## Install

```sh
npm install @perdieminc/hapi-rate-limitor
```

You provide the Redis client, so this package doesn't add one to your dependencies. It supports `ioredis` 5 and 6, on Redis 5 or later and on Valkey.

## Usage

```js
const Redis = require("ioredis");
const { plugin: rateLimit } = require("@perdieminc/hapi-rate-limitor");

const redis = new Redis(process.env.REDIS_URL, {
  // Fail straight away during an outage rather than queueing requests.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

// Without a listener, ioredis logs every reconnect failure to stderr.
redis.on("error", (error) => logger.warn({ err: error }, "rate limit redis error"));

await server.register({
  plugin: rateLimit,
  options: { redis, max: 120, duration: 60_000 },
});

server.ext("onPostStop", () => redis.quit());
```

Use one client for rate limiting, not your application's shared client. Options like `enableOfflineQueue` would otherwise affect the rest of your app.

## Route limits

```js
server.route({
  method: "POST",
  path: "/otp",
  options: {
    plugins: {
      "hapi-rate-limitor": {
        max: 5,
        duration: 10 * 60_000,
        // Once exceeded, reject for 30 minutes.
        blockMs: 30 * 60_000,
        // Refuse rather than send SMS unprotected if Redis is down.
        onStoreError: "closed",
      },
    },
    handler,
  },
});
```

A route with its own limit has its own counter per client, shared across all its parameter values. Routes without one share the plugin-wide counter.

### Stopping SMS pumping

IP limits alone don't stop SMS pumping, because attackers rotate through many IPs. Limit the things they can't rotate as cheaply:

```js
'hapi-rate-limitor': {
  onStoreError: 'closed',
  limits: [
    // Per client
    { max: 5, duration: 10 * 60_000 },
    // Per destination number. Normalize first, so formats can't make new counters.
    { max: 3, duration: 10 * 60_000, by: (request) => normalizePhone(request.payload?.phone) },
    // Per number range, which catches rented premium-rate blocks
    { max: 20, duration: 60 * 60_000, by: (request) => normalizePhone(request.payload?.phone)?.slice(0, 7) },
    // Per merchant, as a spend cap
    { max: 500, duration: 60 * 60_000, by: (request) => request.params.store_id }
  ]
}
```

`by` values are hashed before they reach Redis, so phone numbers and emails aren't stored. A missing value counts by client, so it can't skip the limit. The payload is parsed by `onPostAuth`, so don't combine `by` on payload fields with an earlier `extensionPoint`.

Use `by` only on values that are validated, or that clients can't invent freely. Each distinct value creates a Redis key until its window ends. On Redis Cluster, a route using `by` keeps all its counters on one slot.

### Counting real sends

Route limits count requests, so junk requests can use up a shared budget and block real customers. Count country, merchant and global budgets where the message is actually sent:

```js
const rateLimit = server.plugins["hapi-rate-limitor"];
const result = await rateLimit.consume({
  key: `sms:country:${country}`,
  limits: [{ max: 1000, duration: 60 * 60_000 }],
  onStoreError: "closed",
});

if (!result.isInQuota()) {
  // Don't send. Alert someone, because a global cap can block real customers too.
}
```

`consume` returns `null` under the `open` policy or when the plugin is disabled, and rejects with an error during a store failure under `closed`. Pass `peek: true` to check a budget without counting, for example before paying for a phone lookup.

### Failed logins

Limits run after authentication by default, and hapi skips that step when authentication fails. So normal limits never see failed logins. Use `authFailures`:

```js
'hapi-rate-limitor': { authFailures: { max: 5, duration: 15 * 60_000 } }
```

Or set it in the plugin options to cover every route. It counts by client IP, per route.

Each attempt takes a slot before authentication and gives it back if it doesn't fail, so a burst of parallel guesses can't get past the cap. That means more than `max` simultaneous logins from one IP are briefly rejected, even if they would all succeed.

### Rejecting before the expensive work

Normal limits run after routing, authentication, body parsing and validation, and requests that fail those steps are never counted. `earlyLimit` runs first and counts everything per client IP:

```js
await server.register({
  plugin: rateLimit,
  options: {
    redis,
    earlyLimit: { max: 600, duration: 60_000 },
    // Keep health checks independent of the limiter.
    skip: (request) => request.path === "/health",
  },
});
```

Route options aren't available this early, so `enabled: false` on a route doesn't exempt it. `getIp` and `skip` run here before authentication, so they can't read credentials.

## Client IP

By default the client address comes from `CloudFront-Viewer-Address`, and then the socket. **Only use the default if clients can't reach the server without going through CloudFront.** Anyone connecting directly can send that header and choose their identity, which evades IP limits and can match `allowlist`.

If the server is also directly reachable, guard the source:

```js
ipSources: [
  {
    header: "cloudfront-viewer-address",
    hasPort: true,
    when: (request) => isFromCloudFront(request),
  },
];
```

| Setup                                               | `ipSources`                                          |
| --------------------------------------------------- | ---------------------------------------------------- |
| CloudFront only                                     | The default                                          |
| One load balancer that appends to `X-Forwarded-For` | `[{ forwardedForHops: 1 }]`                          |
| CloudFront, then a load balancer                    | `[{ forwardedForHops: 2 }]`                          |
| A trusted internal caller forwards the address      | `[{ header: 'x-client-ip', when: isTrustedCaller }]` |
| Directly on the internet                            | `[]`                                                 |

Hop counts must be exact. Too low and clients share the proxy's limit; too high and clients can pick their own key. Never read the first `X-Forwarded-For` entry, because clients control it.

IPv6 clients are counted per /64, because one customer usually controls a whole /64.

## When Redis is unavailable

| `onStoreError`    | Behaviour                                    | Use for                               |
| ----------------- | -------------------------------------------- | ------------------------------------- |
| `local` (default) | Limits per server process, in memory         | Most routes                           |
| `open`            | Allows requests, sends no rate limit headers | Routes that must never be blocked     |
| `closed`          | Answers 503 with `Retry-After`               | SMS, payments and other costly routes |

With `local`, the effective limit is `max` times your number of server processes until Redis returns.

## Options

| Option               | Default                  | Description                                                                                                                                     |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis`              | Required                 | An `ioredis` client or cluster. You own its connection and lifecycle                                                                            |
| `max`                | `60`                     | Requests per `duration`                                                                                                                         |
| `duration`           | `60000`                  | Window in milliseconds                                                                                                                          |
| `blockMs`            |                          | Once exceeded, keep rejecting for this long                                                                                                     |
| `countRejected`      | `false`                  | Count rejected requests, so a client stays limited until it backs off                                                                           |
| `enabled`            | `true`                   | `false` turns the plugin off                                                                                                                    |
| `namespace`          | `rate-limit`             | Prefix for Redis keys                                                                                                                           |
| `extensionPoint`     | `onPostAuth`             | Lifecycle step that applies limits                                                                                                              |
| `userAttribute`      | `id`                     | Credentials property identifying a user                                                                                                         |
| `userLimitAttribute` | `rateLimit`              | Credentials property holding a user's own `max`                                                                                                 |
| `routeOptionKey`     | `hapi-rate-limitor`      | Key under `route.options.plugins`                                                                                                               |
| `ipSources`          | CloudFront header        | Where to read the client address, in order                                                                                                      |
| `getIp`              |                          | Replaces `ipSources`. An empty result uses the socket address                                                                                   |
| `allowlist`          | `[]`                     | IP addresses or CIDR ranges that skip limits                                                                                                    |
| `skip`               |                          | `(request) => boolean` to skip limits                                                                                                           |
| `getRouteKey`        | Method and path template | Identifies the counter for routes with their own limit                                                                                          |
| `emitter`            | Server events            | Where to send events                                                                                                                            |
| `onExceeded`         | 429 JSON                 | `(request, h, rateLimit) => response`                                                                                                           |
| `onStoreError`       | `local`                  | See above                                                                                                                                       |
| `storeTimeoutMs`     | `250`                    | Longest a request waits for Redis                                                                                                               |
| `shield`             | `true`                   | Remember rejected clients in memory. Turn off if you delete keys to unblock clients, because servers keep rejecting until the retry time passes |
| `authFailures`       |                          | `{ max, duration, statusCodes }`. `statusCodes` defaults to `[401]`                                                                             |
| `earlyLimit`         |                          | `{ max, duration, blockMs }`. Limits per client IP before routing and authentication                                                            |

Invalid route options fail at server start. Routes accept `enabled`, `max`, `duration`, `blockMs`, `countRejected`, `limits`, `onStoreError`, `authFailures` and `getRouteKey`. Precedence for `max` is route, then the user's own limit, then the plugin default.

## Responses

Every limited response has `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining` and `X-Rate-Limit-Reset` (epoch seconds). Rejected responses add `Retry-After`. `request.rateLimit` holds the same values.

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "You have exceeded the request limit"
}
```

## Events

`rate-limit:attempt`, `rate-limit:in-quota` and `rate-limit:exceeded` receive the request. `rate-limit:store-error` receives the error. A failing listener is logged and doesn't affect the request.

## Limits of this package

- **It isn't DDoS protection on its own.** Requests still reach your servers. Use a WAF for volumetric attacks.
- **It limits rate, not concurrency or cost.** A slow route costs the same as a fast one, and open streams aren't capped.
- **Memory.** Each client's log holds at most `max` entries, for `duration`. Very high limits across many clients use more Redis memory.

## Upgrading from 4.x

Version 5 is a full rewrite and requires Node.js 22 or later.

| 4.x                     | 5.x                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis: 'redis://...'`                  | `redis: new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })`                                                                                                     |
| Route options under `hapi-rate-limitor` | Unchanged |
| Route counter per URL                   | `getRouteKey: (request) => request.path` keeps that behaviour, but clients can vary the URL to get new counters. Use it only where you need to, and override it on sensitive routes |
| Client IP from any forwarding header    | Set `ipSources` or `getIp`                                                                                                                                                          |
| `ipWhitelist`                           | `allowlist`                                                                                                                                                                         |
| `view`                                  | `onExceeded`                                                                                                                                                                        |
| Rejected requests kept a client blocked | `countRejected: true` keeps that behaviour                                                                                                                                          |
| Redis failure: 500 on every request     | `onStoreError`, default `local`                                                                                                                                                     |

**Use a new `namespace`.** Keys aren't compatible with 4.x. Counters reset once at deploy.

## Development

```sh
docker run -d -p 6379:6379 redis:7
npm run lint
npm test
```

## Credits

Written from scratch, with ideas from [hapi-rate-limitor](https://github.com/futurestudio/hapi-rate-limitor) by Future Studio, which this package replaces, and [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible).

## License

MIT
