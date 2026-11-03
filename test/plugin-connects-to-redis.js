'use strict'

const Test = require('ava').default
const Hapi = require('@hapi/hapi')

Test('Connects to Redis using a connection string', async (t) => {
  const server = new Hapi.Server()

  await server.register({
    plugin: require('../lib'),
    options: {
      redis: 'redis://localhost',
      namespace: `route-limits-${Date.now()}`
    }
  })

  await server.start()
  await server.stop()

  t.pass()
})

Test('Fails to connect to Redis', async (t) => {
  const server = new Hapi.Server()

  await t.throwsAsync(
    server.register({
      plugin: require('../lib'),
      options: {
        redis: false,
        namespace: `route-limits-${Date.now()}`
      }
    })
  )
})

Test('connects with RESP2 and fast retries, and keeps the given options untouched', async (t) => {
  const RateLimiter = require('../lib/rate-limiter')
  const server = new Hapi.Server()
  const redis = { host: 'localhost' }

  const fromObject = new RateLimiter(server, { redis })
  const fromUrl = new RateLimiter(new Hapi.Server(), { redis: 'redis://localhost' })

  t.is(fromObject.redis.options.protocol, 2)
  t.is(fromUrl.redis.options.protocol, 2)
  t.is(fromObject.redis.options.retryStrategy(1), 50)
  t.is(fromUrl.redis.options.retryStrategy(1000), 2000)
  t.deepEqual(redis, { host: 'localhost' })
})

Test('lets callers override the connection defaults', (t) => {
  const RateLimiter = require('../lib/rate-limiter')
  const retryStrategy = () => 1
  const limiter = new RateLimiter(new Hapi.Server(), { redis: { protocol: 3, retryStrategy } })

  t.is(limiter.redis.options.protocol, 3)
  t.is(limiter.redis.options.retryStrategy, retryStrategy)
})
