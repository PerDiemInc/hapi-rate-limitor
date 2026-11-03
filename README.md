# @perdieminc/hapi-rate-limitor

[![NPM Version](https://img.shields.io/npm/v/@perdieminc/hapi-rate-limitor.svg?style=flat-square)](https://www.npmjs.com/package/@perdieminc/hapi-rate-limitor)
[![Node.js Version](https://img.shields.io/node/v/@perdieminc/hapi-rate-limitor.svg?style=flat-square)](https://nodejs.org)

A powerful rate limiting plugin for hapi.js that helps prevent brute-force attacks and API abuse.

## Features

- 🚀 **Custom Redis Support**: Works with both standard Redis instances and Redis Cluster
- 🔒 **Flexible Rate Limiting**: Global, route-specific, and user-specific limits
- 🎯 **IP-based & User-based**: Rate limit by IP address or authenticated user
- 📊 **Response Headers**: Automatic rate limit headers (`X-Rate-Limit-*`)
- 🎨 **Custom Views**: Render custom views when rate limit is exceeded
- ⚡ **Event Emitters**: Hook into rate limiting events
- 🔧 **Highly Configurable**: Whitelist IPs, skip routes, custom extension points

## Requirements

- **Node.js**: >= 22
- **hapi**: >= 21
- **Redis**: A running Redis instance or Redis Cluster

## Installation

```bash
npm install @perdieminc/hapi-rate-limitor
```

## Quick Start

```javascript
const Hapi = require('@hapi/hapi');

const server = new Hapi.Server({
  port: 3000
});

await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: 'redis://localhost:6379',
    max: 60,                    // 60 requests
    duration: 60 * 1000,        // per 60 seconds
    namespace: 'my-app-limiter'
  }
});

await server.start();
```

## Redis Configuration

### Standard Redis Instance

The plugin supports multiple ways to configure a standard Redis connection:

#### Connection String

```javascript
await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: 'redis://localhost:6379'
  }
});
```

#### Configuration Object

```javascript
await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: {
      host: 'localhost',
      port: 6379,
      password: 'your-password',
      db: 0
    }
  }
});
```

### Custom Redis Instance

You can pass your own pre-configured Redis instance (useful for connection pooling or custom configurations):

```javascript
const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6379,
  password: 'your-password',
  retryStrategy: (times) => {
    return Math.min(times * 50, 2000);
  }
});

await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: redis  // Pass your custom Redis instance
  }
});
```

### Redis Cluster Support

The plugin fully supports Redis Cluster configurations:

```javascript
const Redis = require('ioredis');

const cluster = new Redis.Cluster([
  { host: 'localhost', port: 7000 },
  { host: 'localhost', port: 7001 },
  { host: 'localhost', port: 7002 }
], {
  redisOptions: {
    password: 'your-cluster-password'
  }
});

await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: cluster  // Pass your Redis Cluster instance
  }
});
```

> **Note**: When passing a custom Redis instance or cluster, the plugin will **not** automatically connect or disconnect. You are responsible for managing the connection lifecycle.

## Configuration Options

### Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | Boolean | `true` | Enable/disable rate limiting globally |
| `redis` | String/Object/Redis | **required** | Redis connection string, config object, or Redis instance |
| `max` | Number | `60` | Maximum number of requests allowed |
| `duration` | Number | `60000` | Time window in milliseconds (default: 60 seconds) |
| `namespace` | String | `'hapi-rate-limitor'` | Redis key namespace |
| `userAttribute` | String | `'id'` | User identifier attribute in `request.auth.credentials` |
| `userLimitAttribute` | String | `'rateLimit'` | User-specific rate limit attribute |
| `ipWhitelist` | Array | `[]` | Array of whitelisted IP addresses |
| `extensionPoint` | String | `'onPostAuth'` | Hapi extension point for rate limiting |
| `view` | String | `undefined` | Path to custom view for rate limit exceeded |
| `skip` | Function | `() => false` | Function to skip rate limiting for specific requests |
| `getIp` | Function | `undefined` | Custom function to extract IP address |
| `trustedProxyHops` | Number | `0` | Number of trusted proxies appending to `X-Forwarded-For`. `0` uses the socket address |
| `getRouteId` | Function | `undefined` | Custom identifier for route-specific limits. Defaults to the route's path template |

## Usage Examples

### Basic Rate Limiting

```javascript
await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: 'redis://localhost:6379',
    max: 100,                   // 100 requests
    duration: 60 * 1000,        // per minute
    namespace: 'my-api'
  }
});
```

### Route-Specific Limits

You can set different rate limits for specific routes:

```javascript
server.route({
  method: 'POST',
  path: '/login',
  options: {
    plugins: {
      'hapi-rate-limitor': {
        max: 5,                 // Only 5 login attempts
        duration: 5 * 60 * 1000 // per 5 minutes
      }
    },
    handler: async (request, h) => {
      return { success: true };
    }
  }
});
```

### Disable Rate Limiting for Specific Routes

```javascript
server.route({
  method: 'GET',
  path: '/health',
  options: {
    plugins: {
      'hapi-rate-limitor': {
        enabled: false  // No rate limiting for health checks
      }
    },
    handler: async (request, h) => {
      return { status: 'ok' };
    }
  }
});
```

### IP Whitelist

```javascript
await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: 'redis://localhost:6379',
    ipWhitelist: [
      '127.0.0.1',
      '::1',
      '10.0.0.0/8'  // Internal network
    ]
  }
});
```

### User-Specific Rate Limits

For authenticated users, you can set per-user rate limits:

```javascript
// In your authentication handler
request.auth.credentials = {
  id: 'user-123',
  rateLimit: 1000  // This user gets 1000 requests per duration
};
```

### Custom View for Rate Limit Exceeded

```javascript
await server.register([
  {
    plugin: require('@hapi/vision')
  },
  {
    plugin: require('@perdieminc/hapi-rate-limitor'),
    options: {
      redis: 'redis://localhost:6379',
      view: 'rate-limit-exceeded'  // Render this view when exceeded
    }
  }
]);

server.views({
  engines: { html: require('handlebars') },
  path: 'views'
});
```

### Skip Rate Limiting Conditionally

```javascript
await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: 'redis://localhost:6379',
    skip: (request) => {
      // Skip rate limiting for admin users
      return request.auth.credentials?.role === 'admin';
    }
  }
});
```

### Custom IP Detection

```javascript
await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: 'redis://localhost:6379',
    getIp: (request) => {
      // Read the address your infrastructure vouches for. See "Security Considerations".
      return request.headers['cf-connecting-ip'] || request.info.remoteAddress;
    }
  }
});
```

### Custom Extension Point

```javascript
await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: 'redis://localhost:6379',
    extensionPoint: 'onPreAuth'  // Rate limit before authentication
  }
});
```

## Rate Limit Events

The plugin emits events that you can listen to:

```javascript
await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    redis: 'redis://localhost:6379',
    emitter: {
      on: (event, callback) => {
        if (event === 'rate-limit:exceeded') {
          callback((request) => {
            console.log(`Rate limit exceeded for ${request.info.remoteAddress}`);
          });
        }

        if (event === 'rate-limit:in-quota') {
          callback((request) => {
            console.log(`Request within quota: ${request.path}`);
          });
        }
      }
    }
  }
});
```

## Response Headers

The plugin automatically adds rate limit headers to all responses:

```
X-Rate-Limit-Limit: 60
X-Rate-Limit-Remaining: 59
X-Rate-Limit-Reset: 1639584000
```

- `X-Rate-Limit-Limit`: Maximum number of requests allowed
- `X-Rate-Limit-Remaining`: Number of requests remaining in the current window
- `X-Rate-Limit-Reset`: Unix timestamp (in seconds) when the rate limit resets

## Error Response

When the rate limit is exceeded, the plugin returns a `429 Too Many Requests` response:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "You have exceeded the request limit"
}
```

## Advanced Configuration

### Complete Example with All Options

```javascript
const Redis = require('ioredis');

const redis = new Redis.Cluster([
  { host: 'redis-node-1', port: 7000 },
  { host: 'redis-node-2', port: 7001 },
  { host: 'redis-node-3', port: 7002 }
]);

await server.register({
  plugin: require('@perdieminc/hapi-rate-limitor'),
  options: {
    enabled: true,
    redis: redis,
    max: 100,
    duration: 60 * 1000,
    namespace: 'my-app-rate-limiter',
    userAttribute: 'userId',
    userLimitAttribute: 'maxRequests',
    ipWhitelist: ['127.0.0.1', '::1'],
    extensionPoint: 'onPostAuth',
    view: 'rate-limit-exceeded',
    skip: (request) => {
      return request.path.startsWith('/public');
    },
    getIp: (request) => {
      return request.headers['x-forwarded-for']?.split(',')[0] ||
             request.info.remoteAddress;
    }
  }
});
```

## Security Considerations

**Client IP detection ignores forwarding headers by default.** Clients can set `X-Forwarded-For` themselves, so the plugin uses the socket address unless you opt in. Behind a load balancer, the socket address is the load balancer, so all clients share one limit until you set `trustedProxyHops` to the number of proxies that append to `X-Forwarded-For`:

```js
// One AWS ALB in front of the server
trustedProxyHops: 1

// CloudFront in front of an ALB
trustedProxyHops: 2
```

If your proxies don't follow this pattern, use `getIp` to read the address your infrastructure vouches for. Never read the first `X-Forwarded-For` entry: it's client-controlled.

**Failed authentication isn't rate limited by default.** The default `extensionPoint` is `onPostAuth`, and hapi skips that step when authentication fails, so guessed passwords never count against the limit. To protect credentials from brute force, use `extensionPoint: 'onPreAuth'`. Requests are then limited by IP only, because credentials aren't available yet.

**Route limits apply per route, across all parameter values.** A route `/stores/{store_id}/otp` with its own `max` has one counter per client across every `store_id`. To count per tenant or per URL instead, use `getRouteId`. Only do this for parameters clients can't vary freely, because each value gets its own counter and Redis key:

```js
getRouteId: (request) => `${request.params.store_id}:${request.route.path}`
```

## TypeScript Support

The plugin includes TypeScript definitions:

```typescript
import { Server } from '@hapi/hapi';
import * as RateLimitor from '@perdieminc/hapi-rate-limitor';

const server = new Server({ port: 3000 });

await server.register({
  plugin: RateLimitor,
  options: {
    redis: 'redis://localhost:6379',
    max: 60,
    duration: 60000
  }
});
```

## Testing

```bash
npm test
```

## License

MIT © [Marcus Pöhls](https://futurestud.io)

## Acknowledgments

This package is a fork of the [hapi-rate-limitor](https://github.com/futurestudio/hapi-rate-limitor) created by [Marcus Pöhls](https://github.com/marcuspoehls) and the [Future Studio](https://futurestud.io) team.

**Original Repository**: [futurestudio/hapi-rate-limitor](https://github.com/futurestudio/hapi-rate-limitor)

We are grateful for their work and contributions to the hapi.js ecosystem. This fork maintains compatibility with the original while adding enhanced documentation and examples, particularly around Redis Cluster support.

If you find this package useful, please consider:
- ⭐ Starring the [original repository](https://github.com/futurestudio/hapi-rate-limitor)
- 💖 Supporting [Future Studio](https://futurestud.io)
- 🤝 Contributing back improvements to the upstream project

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

For changes that could benefit the broader community, consider contributing to the [original repository](https://github.com/futurestudio/hapi-rate-limitor) as well.

## Credits

This plugin uses:
- [ioredis](https://github.com/luin/ioredis) for Redis connectivity
- [async-ratelimiter](https://github.com/microlinkhq/async-ratelimiter) for rate limiting logic
- [@supercharge/request-ip](https://github.com/supercharge/request-ip) for IP detection

---

**Made with ❤️ for the hapi.js community**


## Development & Release

### Creating a New Release

When you're ready to release a new version:

1. **Update version and create tag** (automatically):
   ```bash
   npm version patch  # For bug fixes (4.0.1 -> 4.0.2)
   npm version minor  # For new features (4.0.1 -> 4.1.0)
   npm version major  # For breaking changes (4.0.1 -> 5.0.0)
   ```
   This automatically updates `package.json`, creates a commit, and creates a git tag.

2. **Push the tag** (triggers automatic publish):
   ```bash
   git push origin master --follow-tags
   ```

3. **GitHub Actions automatically**:
   - ✅ Runs all tests
   - ✅ Publishes to npm
   - ✅ Creates a GitHub Release with auto-generated notes

#### Manual Release (if needed)

If you need to publish manually without the automation:

```bash
npm publish --access public
```

#### Delete a Tag (if you made a mistake)

```bash
# Delete local tag
git tag -d v4.0.2

# Delete remote tag
git push origin --delete v4.0.2
```

### Syncing with Upstream

To get the latest updates from the original repository:

```bash
git fetch upstream
git merge upstream/master
git push origin master
```

See the [upstream repository](https://github.com/futurestudio/hapi-rate-limitor) for the latest changes.
