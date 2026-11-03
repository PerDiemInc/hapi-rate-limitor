const { randomUUID } = require("node:crypto");
const Hapi = require("@hapi/hapi");
const Redis = require("ioredis");
const { plugin } = require("../dist");

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const COMMAND_NAME = "perdiemHapiRateLimit";

const namespace = () => `test-${randomUUID()}`;

function createRedis() {
  return new Redis(REDIS_URL, { protocol: 2, maxRetriesPerRequest: 1 });
}

/** A client whose rate limit command behaves as `command` says, without Redis. */
function fakeRedis(command) {
  const client = { calls: 0, defineCommand() {} };

  client[COMMAND_NAME] = (...args) => {
    client.calls++;

    return command(...args);
  };

  return client;
}

const hangingRedis = () => fakeRedis(() => new Promise(() => {}));
const failingRedis = () => fakeRedis(() => Promise.reject(new Error("connection lost")));

async function createServer(
  options,
  routes = [{ method: "GET", path: "/", handler: () => "ok" }],
  setup,
) {
  const server = new Hapi.Server({ debug: false });

  await setup?.(server);
  await server.register({ plugin, options: { namespace: namespace(), ...options } });
  server.route(routes);
  await server.initialize();

  return server;
}

async function statuses(server, requests) {
  const codes = [];

  for (const request of requests) {
    codes.push((await server.inject(request)).statusCode);
  }

  return codes;
}

const times = (count, value) =>
  Array.from({ length: count }, (_item, index) =>
    typeof value === "function" ? value(index) : value,
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  createRedis,
  createServer,
  fakeRedis,
  failingRedis,
  hangingRedis,
  namespace,
  plugin,
  sleep,
  statuses,
  times,
};
