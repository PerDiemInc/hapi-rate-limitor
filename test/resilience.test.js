const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  createRedis,
  createServer,
  failingRedis,
  fakeRedis,
  hangingRedis,
  sleep,
  statuses,
  times,
} = require("./helpers");

const realRedis = createRedis();

after(() => realRedis.quit());

test("a hung Redis costs each request at most the timeout", async () => {
  const server = await createServer({ redis: hangingRedis(), storeTimeoutMs: 50, max: 100 });
  const start = Date.now();
  const response = await server.inject("/");

  assert.equal(response.statusCode, 200);
  assert.ok(Date.now() - start < 500, `${Date.now() - start}ms`);
});

test("the local policy still limits while Redis is down", async () => {
  const server = await createServer({ redis: failingRedis(), max: 2 });

  assert.deepEqual(await statuses(server, ["/", "/", "/", "/"]), [200, 200, 429, 429]);
});

test("the open policy lets requests through and sends no headers", async () => {
  const server = await createServer({ redis: failingRedis(), max: 1, onStoreError: "open" });
  const responses = [await server.inject("/"), await server.inject("/")];

  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [200, 200],
  );
  assert.equal(responses[0].headers["x-rate-limit-limit"], undefined);
});

test("the closed policy answers 503 with Retry-After", async () => {
  const server = await createServer({ redis: failingRedis(), onStoreError: "closed" });
  const response = await server.inject("/");

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers["retry-after"], "1");
});

test("a route can fail closed while the rest of the API stays up", async () => {
  const routes = [
    { method: "GET", path: "/", handler: () => "ok" },
    {
      method: "POST",
      path: "/send-sms",
      options: { plugins: { "hapi-rate-limitor": { max: 5, onStoreError: "closed" } } },
      handler: () => "sent",
    },
  ];
  const server = await createServer({ redis: failingRedis() }, routes);

  assert.equal((await server.inject("/")).statusCode, 200);
  assert.equal((await server.inject({ method: "POST", url: "/send-sms" })).statusCode, 503);
});

test("authFailures fail closed on a route that asks for it", async () => {
  const route = {
    method: "GET",
    path: "/",
    options: {
      plugins: {
        "hapi-rate-limitor": {
          onStoreError: "closed",
          enabled: true,
          authFailures: { max: 1, duration: 1000 },
        },
      },
    },
    handler: () => "ok",
  };
  const server = await createServer({ redis: failingRedis() }, [route]);

  assert.equal((await server.inject("/")).statusCode, 503);
});

test("store failures are reported by event", async () => {
  const errors = [];
  const server = await createServer({ redis: failingRedis() });

  server.events.on("rate-limit:store-error", (error) => errors.push(error.message));
  await server.inject("/");

  assert.deepEqual(errors, ["connection lost"]);
});

test("the circuit breaker stops calling a failing Redis, then recovers", async () => {
  let healthy = false;
  const client = fakeRedis(async () => {
    if (!healthy) {
      throw new Error("down");
    }

    return [1, 100, 99, Date.now() + 1000, 0];
  });
  const server = await createServer({ redis: client, max: 1000 });

  await statuses(server, times(30, "/"));
  assert.equal(client.calls, 5);

  healthy = true;
  await sleep(1_100);

  const response = await server.inject("/");

  assert.equal(response.statusCode, 200);
  assert.equal(client.calls, 6);
  assert.equal(response.headers["x-rate-limit-limit"], "100");
});

test("the shield keeps rejected traffic away from Redis", async () => {
  const client = fakeRedis(async () => [0, 1, 0, Date.now() + 60_000, 60_000]);
  const server = await createServer({ redis: client });
  const codes = await statuses(server, times(50, "/"));

  assert.deepEqual([...new Set(codes)], [429]);
  assert.equal(client.calls, 1);
});

test("the shield lets a client back in after its retry time", async () => {
  let reply = [0, 1, 0, Date.now() + 100, 100];
  const client = fakeRedis(async () => reply);
  const server = await createServer({ redis: client });

  assert.equal((await server.inject("/")).statusCode, 429);
  reply = [1, 1, 0, Date.now() + 100, 0];
  assert.equal((await server.inject("/")).statusCode, 429);
  await sleep(120);
  assert.equal((await server.inject("/")).statusCode, 200);
});

test("the shield can be turned off, and never covers countRejected", async () => {
  const client = fakeRedis(async () => [0, 1, 0, Date.now() + 60_000, 60_000]);
  const off = await createServer({ redis: client, shield: false });

  await statuses(off, times(3, "/"));
  assert.equal(client.calls, 3);

  const counting = fakeRedis(async () => [0, 1, 0, Date.now() + 60_000, 60_000]);
  const server = await createServer({ redis: counting, countRejected: true });

  await statuses(server, times(3, "/"));
  assert.equal(counting.calls, 3);
});

test("a shielded response keeps a correct Retry-After", async () => {
  const client = fakeRedis(async () => [0, 1, 0, Date.now() + 60_000, 60_000]);
  const server = await createServer({ redis: client });

  await server.inject("/");

  const response = await server.inject("/");

  assert.ok(Number(response.headers["retry-after"]) > 55);
});

test("unexpected non-store errors are not swallowed", async () => {
  const server = await createServer({
    redis: realRedis,
    skip: () => {
      throw new Error("skip bug");
    },
  });

  assert.equal((await server.inject("/")).statusCode, 500);
});

test("a late Redis failure after the timeout does not crash the process", async () => {
  const client = fakeRedis(
    () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 60)),
  );
  const server = await createServer({ redis: client, storeTimeoutMs: 10 });

  assert.equal((await server.inject("/")).statusCode, 200);
  await sleep(100);
});

test("consume follows the store error policy", async () => {
  const server = await createServer({ redis: failingRedis() });
  const { consume } = server.plugins["hapi-rate-limitor"];
  const limits = [{ max: 1, duration: 60_000 }];

  assert.equal((await consume({ key: "a", limits })).isInQuota(), true);
  assert.equal((await consume({ key: "a", limits })).isInQuota(), false);
  assert.equal(await consume({ key: "b", limits, onStoreError: "open" }), null);
  await assert.rejects(consume({ key: "c", limits, onStoreError: "closed" }), /unavailable/);
});

test("after the cooldown only one request waits on a hung Redis", async () => {
  const client = hangingRedis();
  const server = await createServer({ redis: client, storeTimeoutMs: 100, max: 100_000 });

  await statuses(server, times(5, "/"));
  assert.equal(client.calls, 5);

  await sleep(1_050);

  const start = Date.now();
  const responses = await Promise.all(times(20, () => server.inject("/")));
  const fast = await Promise.all(
    times(5, async () => {
      const before = Date.now();

      await server.inject("/");

      return Date.now() - before;
    }),
  );

  assert.equal(client.calls, 6);
  assert.ok(responses.every((response) => response.statusCode === 200));
  assert.ok(Math.max(...fast) < 80, String(Math.max(...fast)));
  assert.ok(Date.now() - start < 500);
});

test("a failed release does not change the response", async () => {
  const calls = [];
  const client = fakeRedis(async (...args) => {
    const mode = args[3];

    calls.push(mode);

    if (mode === "release") {
      throw new Error("down");
    }

    return [1, 5, 4, Date.now() + 1000, 0];
  });
  const route = {
    method: "GET",
    path: "/",
    options: { plugins: { "hapi-rate-limitor": { authFailures: { max: 5, duration: 1000 } } } },
    handler: () => "ok",
  };
  const server = await createServer({ redis: client, max: 100 }, [route]);

  assert.equal((await server.inject("/")).statusCode, 200);
  assert.ok(calls.includes("release"));
});
