'use strict'

const Test = require('ava').default
const Hapi = require('@hapi/hapi')

async function createServer (options) {
  const server = new Hapi.Server()

  await server.register({
    plugin: require('../lib'),
    options: { namespace: `route-ids-${Date.now()}-${Math.random()}`, ...options }
  })

  server.route({
    method: 'GET',
    path: '/otp/{phone}',
    options: { plugins: { 'hapi-rate-limitor': { max: 1 } } },
    handler: () => 'ok'
  })
  await server.initialize()

  return server
}

Test('changing a path parameter can’t evade a route limit', async (t) => {
  const server = await createServer()

  t.is((await server.inject('/otp/1')).statusCode, 200)
  t.is((await server.inject('/otp/2')).statusCode, 429)

  await server.stop()
})

Test('getRouteId can keep counters per URL', async (t) => {
  const server = await createServer({ getRouteId: async request => request.path })

  t.is((await server.inject('/otp/1')).statusCode, 200)
  t.is((await server.inject('/otp/2')).statusCode, 200)
  t.is((await server.inject('/otp/1')).statusCode, 429)

  await server.stop()
})
