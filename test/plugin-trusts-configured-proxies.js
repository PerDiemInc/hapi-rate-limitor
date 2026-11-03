'use strict'

const Test = require('ava').default
const Hapi = require('@hapi/hapi')

async function createServer (options) {
  const server = new Hapi.Server()

  await server.register({
    plugin: require('../lib'),
    options: { max: 1, namespace: `trusted-proxies-${Date.now()}-${Math.random()}`, ...options }
  })

  server.route({ method: 'GET', path: '/', handler: () => 'ok' })
  await server.initialize()

  return server
}

function get (server, forwardedFor, remoteAddress = '10.0.0.1') {
  const headers = forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}

  return server.inject({ url: '/', headers, remoteAddress })
}

Test('ignores forwarding headers by default', async (t) => {
  const server = await createServer()

  t.is((await get(server, '9.9.9.1')).statusCode, 200)
  t.is((await get(server, '9.9.9.2')).statusCode, 429)

  await server.stop()
})

Test('client-supplied IP can’t match the whitelist by default', async (t) => {
  const server = await createServer({ ipWhitelist: ['8.8.8.8'] })

  t.is((await server.inject({ url: '/', headers: { 'x-forwarded-for': '8.8.8.8' } })).headers['x-rate-limit-limit'], 1)

  await server.stop()
})

Test('uses the entry added by the trusted proxy and ignores spoofed entries', async (t) => {
  const server = await createServer({ trustedProxyHops: 1 })

  t.is((await get(server, 'spoof-1, 1.1.1.1')).statusCode, 200)
  t.is((await get(server, 'spoof-2, 1.1.1.1')).statusCode, 429)
  t.is((await get(server, '2.2.2.2')).statusCode, 200)

  await server.stop()
})

Test('counts proxy hops from the right', async (t) => {
  const server = await createServer({ trustedProxyHops: 2 })

  t.is((await get(server, 'spoof-1, 1.1.1.1, 3.3.3.3')).statusCode, 200)
  t.is((await get(server, 'spoof-2, 1.1.1.1, 4.4.4.4')).statusCode, 429)

  await server.stop()
})

Test('falls back to the socket address for too few or invalid entries', async (t) => {
  const server = await createServer({ trustedProxyHops: 2 })

  t.is((await get(server, '1.1.1.1', '10.0.0.5')).statusCode, 200)
  t.is((await get(server, 'not-an-ip, 2.2.2.2', '10.0.0.5')).statusCode, 429)

  await server.stop()
})

for (const trustedProxyHops of [-1, 1.5, '1']) {
  Test(`rejects trustedProxyHops of ${JSON.stringify(trustedProxyHops)}`, async (t) => {
    const server = new Hapi.Server()

    await t.throwsAsync(
      server.register({ plugin: require('../lib'), options: { trustedProxyHops } })
    )
  })
}
