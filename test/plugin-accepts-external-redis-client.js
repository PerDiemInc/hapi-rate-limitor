'use strict'

const Test = require('ava').default
const Hapi = require('@hapi/hapi')
const Redis = require('ioredis')

async function createServer (redis, namespace) {
  const server = new Hapi.Server()

  await server.register({
    plugin: require('../lib'),
    options: { redis, namespace, max: 5 }
  })

  server.route({ method: 'GET', path: '/', handler: () => 'ok' })
  await server.initialize()

  return server
}

Test('uses an ioredis instance and leaves it connected', async (t) => {
  const redis = new Redis()
  const namespace = `external-client-${Date.now()}`
  const server = await createServer(redis, namespace)

  const response = await server.inject('/')
  await server.stop()

  t.is(response.statusCode, 200)
  t.is(await redis.ping(), 'PONG')
  t.is((await redis.keys(`${namespace}:*`)).length, 1)

  await redis.quit()
})

Test('uses a client created by another copy of ioredis', async (t) => {
  const redis = new Redis()
  const namespace = `foreign-client-${Date.now()}`

  // `instanceof Redis` is false for this client, like one from a different ioredis version.
  const foreignClient = {
    defineCommand: (...args) => redis.defineCommand(...args),
    get ratelimiter () {
      return redis.ratelimiter?.bind(redis)
    }
  }
  t.false(foreignClient instanceof Redis)

  const server = await createServer(foreignClient, namespace)
  const response = await server.inject('/')

  t.is(response.statusCode, 200)
  t.is((await redis.keys(`${namespace}:*`)).length, 1)

  await server.stop()
  await redis.quit()
})
