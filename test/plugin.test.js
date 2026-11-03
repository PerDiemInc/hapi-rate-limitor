const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Hapi = require("@hapi/hapi");
const {
  createRedis,
  createServer,
  namespace,
  plugin,
  sleep,
  statuses,
  times,
} = require("./helpers");

const redis = createRedis();

after(() => redis.quit());

const limited = (options, path = "/") => ({
  method: "GET",
  path,
  options: { plugins: { "hapi-rate-limitor": options } },
  handler: () => "ok",
});

const authScheme = (server) => {
  server.auth.scheme("test", () => ({
    authenticate: (request, h) => {
      const credentials = request.headers["x-credentials"];

      return credentials
        ? h.authenticated({ credentials: JSON.parse(credentials) })
        : h.authenticated({ credentials: null });
    },
  }));
  server.auth.strategy("test", "test");
};

test("sends rate limit headers and a 429 in the established format", async () => {
  const server = await createServer({ redis, max: 1 });
  const first = await server.inject("/");

  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-rate-limit-limit"], "1");
  assert.equal(first.headers["x-rate-limit-remaining"], "0");
  assert.ok(Number(first.headers["x-rate-limit-reset"]) > Date.now() / 1000);
  assert.equal(first.headers["retry-after"], undefined);

  const second = await server.inject("/");

  assert.equal(second.statusCode, 429);
  assert.deepEqual(second.result, {
    statusCode: 429,
    error: "Too Many Requests",
    message: "You have exceeded the request limit",
  });
  assert.equal(second.headers["x-rate-limit-remaining"], "0");
  assert.ok(Number(second.headers["retry-after"]) >= 1);
});

test("exposes the result on the request", async () => {
  let seen;
  const server = await createServer({ redis, max: 5 }, [
    {
      method: "GET",
      path: "/",
      handler: (request) => {
        seen = request.rateLimit;
        return "ok";
      },
    },
  ]);

  await server.inject("/");

  assert.equal(seen.total, 5);
  assert.equal(seen.remaining, 4);
  assert.equal(seen.isInQuota(), true);
});

test("a route with its own limit has a separate counter", async () => {
  const server = await createServer({ redis, max: 5 }, [
    limited({ max: 1 }, "/strict"),
    { method: "GET", path: "/", handler: () => "ok" },
  ]);

  assert.deepEqual(await statuses(server, ["/strict", "/strict", "/"]), [200, 429, 200]);
});

test("routes without their own limit share the global counter", async () => {
  const route = (path) => ({ method: "GET", path, handler: () => "ok" });
  const server = await createServer({ redis, max: 2 }, [route("/a"), route("/b")]);

  assert.deepEqual(await statuses(server, ["/a", "/b", "/a"]), [200, 200, 429]);
});

test("a route limit covers all parameter values, per method", async () => {
  const server = await createServer({ redis }, [
    limited({ max: 1 }, "/otp/{phone}"),
    {
      method: "POST",
      path: "/otp/{phone}",
      options: { plugins: { "hapi-rate-limitor": { max: 1 } } },
      handler: () => "ok",
    },
  ]);

  assert.deepEqual(await statuses(server, ["/otp/1", "/otp/2"]), [200, 429]);
  assert.equal((await server.inject({ method: "POST", url: "/otp/1" })).statusCode, 200);
});

test("getRouteKey can keep one counter per URL", async () => {
  const server = await createServer({ redis, getRouteKey: (request) => request.path }, [
    limited({ max: 1 }, "/s/{id}"),
  ]);

  assert.deepEqual(await statuses(server, ["/s/1", "/s/2", "/s/1"]), [200, 200, 429]);
});

test("getRouteKey falls back to the route when it returns nothing", async () => {
  const server = await createServer({ redis, getRouteKey: () => undefined }, [
    limited({ max: 1 }, "/s/{id}"),
  ]);

  assert.deepEqual(await statuses(server, ["/s/1", "/s/2"]), [200, 429]);
});

test("a route can be disabled", async () => {
  const server = await createServer({ redis, max: 1 }, [limited({ enabled: false })]);

  assert.deepEqual(await statuses(server, ["/", "/", "/"]), [200, 200, 200]);
});

test("the plugin can be disabled, and then needs no Redis", async () => {
  const server = await createServer({ enabled: false, max: 1 });

  assert.deepEqual(await statuses(server, ["/", "/"]), [200, 200]);
});

test("skip exempts requests and sends no headers", async () => {
  const server = await createServer({ redis, max: 1, skip: async () => true });
  const responses = [await server.inject("/"), await server.inject("/")];

  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [200, 200],
  );
  assert.equal(responses[0].headers["x-rate-limit-limit"], undefined);
});

test("a 404 is not counted", async () => {
  const server = await createServer({ redis, max: 1 });

  assert.equal((await server.inject("/missing")).statusCode, 404);
  assert.equal((await server.inject("/")).statusCode, 200);
});

test("clients are separate", async () => {
  const server = await createServer({ redis, max: 1 });
  const from = (remoteAddress) => ({ url: "/", remoteAddress });

  assert.deepEqual(
    await statuses(server, [from("1.1.1.1"), from("2.2.2.2"), from("1.1.1.1")]),
    [200, 200, 429],
  );
});

test("authenticated users are counted by id across IPs, with their own max", async () => {
  const route = {
    method: "GET",
    path: "/",
    options: { auth: { strategy: "test", mode: "try" } },
    handler: () => "ok",
  };
  const server = await createServer({ redis, max: 100 }, [route], authScheme);
  const credentials = JSON.stringify({ id: "u1", rateLimit: 2 });
  const request = (ip) => ({
    url: "/",
    remoteAddress: ip,
    headers: { "x-credentials": credentials },
  });

  assert.deepEqual(
    await statuses(server, [request("1.1.1.1"), request("2.2.2.2"), request("3.3.3.3")]),
    [200, 200, 429],
  );
});

test("a user id can never share a counter with an IP", async () => {
  const route = {
    method: "GET",
    path: "/",
    options: { auth: { strategy: "test", mode: "try" } },
    handler: () => "ok",
  };
  const server = await createServer({ redis, max: 1 }, [route], authScheme);
  const asUser = {
    url: "/",
    remoteAddress: "9.9.9.9",
    headers: { "x-credentials": JSON.stringify({ id: "1.1.1.1" }) },
  };

  assert.deepEqual(
    await statuses(server, [asUser, { url: "/", remoteAddress: "1.1.1.1" }]),
    [200, 200],
  );
});

test("an invalid user limit is ignored", async () => {
  const route = {
    method: "GET",
    path: "/",
    options: { auth: { strategy: "test", mode: "try" } },
    handler: () => "ok",
  };
  const server = await createServer({ redis, max: 7 }, [route], authScheme);

  for (const rateLimit of [0, -1, "lots", 1.5, null]) {
    const response = await server.inject({
      url: "/",
      headers: { "x-credentials": JSON.stringify({ id: `u${rateLimit}`, rateLimit }) },
    });

    assert.equal(response.headers["x-rate-limit-limit"], "7", String(rateLimit));
  }
});

test("routeOptionKey changes where route options are read from", async () => {
  const route = {
    method: "GET",
    path: "/",
    options: { plugins: { "custom-limit": { max: 1, duration: 60_000 } } },
    handler: () => "ok",
  };
  const server = await createServer({ redis, routeOptionKey: "custom-limit" }, [route]);

  assert.deepEqual(await statuses(server, ["/", "/"]), [200, 429]);
});

test("fires events on the server", async () => {
  const seen = [];
  const server = await createServer({ redis, max: 1 });

  for (const name of ["attempt", "in-quota", "exceeded"]) {
    server.events.on(`rate-limit:${name}`, () => seen.push(name));
  }

  await statuses(server, ["/", "/"]);

  assert.deepEqual(seen, ["attempt", "in-quota", "attempt", "exceeded"]);
});

test("fires events on a custom emitter, and a listener failure does not break requests", async () => {
  const emitter = new EventEmitter();
  const seen = [];

  emitter.on("rate-limit:exceeded", (request) => seen.push(request.path));
  emitter.on("rate-limit:attempt", () => {
    throw new Error("listener bug");
  });

  const server = await createServer({ redis, max: 1, emitter });

  assert.deepEqual(await statuses(server, ["/", "/"]), [200, 429]);
  assert.deepEqual(seen, ["/"]);
});

test("onExceeded builds a custom response, with headers", async () => {
  const server = await createServer({
    redis,
    max: 1,
    onExceeded: (_request, h, rateLimit) => h.response({ wait: rateLimit.retryAfter }).code(429),
  });

  await server.inject("/");

  const response = await server.inject("/");

  assert.equal(response.statusCode, 429);
  assert.ok(response.result.wait >= 1);
  assert.ok(response.headers["x-rate-limit-limit"]);
});

test("rejects bad configuration when registering", async () => {
  const bad = [
    {},
    { redis: null },
    { redis: "redis://localhost" },
    { redis, max: 0 },
    { redis, max: 1.5 },
    { redis, duration: -1 },
    { redis, blockMs: 0 },
    { redis, onStoreError: "maybe" },
    { redis, storeTimeoutMs: 0 },
    { redis, skip: "nope" },
    { redis, getIp: 1 },
    { redis, allowlist: ["not-an-ip"] },
    { redis, ipSources: [{ forwardedForHops: 0 }] },
    { redis, ipSources: [{ header: 5 }] },
    { redis, authFailures: { max: 0, duration: 1 } },
    { redis, authFailures: { max: 1, duration: 1, statusCodes: 401 } },
    { redis, earlyLimit: { max: 0, duration: 1 } },
    { redis, extensionPoint: "onRequest" },
    { redis, allowlist: ["10.0.0.0/"] },
    { redis, allowlist: ["10.0.0.0/33"] },
    { redis, allowlist: ["10.0.0.0/8/16"] },
    { redis, allowlist: ["2001:db8::/129"] },
  ];

  for (const options of bad) {
    const server = new Hapi.Server();

    await assert.rejects(
      server.register({ plugin, options: { namespace: namespace(), ...options } }),
      /hapi-rate-limitor/,
      JSON.stringify(Object.keys(options)),
    );
  }
});

test("a bad route limit fails at server start", async () => {
  await assert.rejects(createServer({ redis }, [limited({ max: 0 })]), /hapi-rate-limitor: route/);
  await assert.rejects(createServer({ redis }, [limited({ limits: [] })]), /limits/);
});

test("a route with only countRejected gets its own limit that counts rejections", async () => {
  const server = await createServer({ redis, max: 1, duration: 200 }, [
    limited({ countRejected: true }),
  ]);

  await statuses(server, ["/", "/"]);

  for (let i = 0; i < 6; i++) {
    await sleep(50);
    assert.equal((await server.inject("/")).statusCode, 429);
  }
});

test("onExceeded can return a plain value or a Boom error", async () => {
  const plain = await createServer({ redis, max: 1, onExceeded: () => ({ wait: true }) });

  await plain.inject("/");

  const response = await plain.inject("/");

  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.result, { wait: true });

  const boomLike = Object.assign(new Error("slow"), {
    isBoom: true,
    output: {
      statusCode: 429,
      payload: { statusCode: 429, error: "x", message: "slow" },
      headers: {},
    },
    reformat() {},
  });
  const boom = await createServer({ redis, max: 1, onExceeded: () => boomLike });

  await boom.inject("/");
  assert.equal((await boom.inject("/")).statusCode, 429);
});

test("consume still exists when the plugin is disabled", async () => {
  const server = await createServer({ enabled: false });

  assert.equal(
    await server.plugins["hapi-rate-limitor"].consume({
      key: "a",
      limits: [{ max: 1, duration: 1 }],
    }),
    null,
  );
});

test("consume rejects empty limits and can peek without counting", async () => {
  const server = await createServer({ redis });
  const { consume } = server.plugins["hapi-rate-limitor"];
  const limits = [{ max: 1, duration: 60_000 }];

  await assert.rejects(consume({ key: "a", limits: [] }), /at least one limit/);
  assert.equal((await consume({ key: "a", limits, peek: true })).remaining, 1);
  assert.equal((await consume({ key: "a", limits, peek: true })).remaining, 1);
  assert.equal((await consume({ key: "a", limits })).remaining, 0);
});

test("a route can apply several limits", async () => {
  const server = await createServer({ redis }, [
    limited({
      limits: [
        { max: 1, duration: 60_000 },
        { max: 5, duration: 60_000 },
      ],
    }),
  ]);

  assert.deepEqual(await statuses(server, ["/", "/"]), [200, 429]);
});

test("sequential limits hold under real parallel load", async () => {
  const server = await createServer({ redis, max: 10 });
  const responses = await Promise.all(times(100, () => server.inject("/")));

  assert.equal(responses.filter((response) => response.statusCode === 200).length, 10);
});

test("a disabled plugin still rejects bad options and route limits", async () => {
  const badOptions = new Hapi.Server();

  await assert.rejects(
    badOptions.register({ plugin, options: { enabled: false, max: 0 } }),
    /hapi-rate-limitor/,
  );

  const badAllowlist = new Hapi.Server();

  await assert.rejects(
    badAllowlist.register({ plugin, options: { enabled: false, allowlist: ["10.0.0.0/"] } }),
    /allowlist/,
  );

  await assert.rejects(
    createServer({ enabled: false }, [limited({ max: 0 })]),
    /hapi-rate-limitor: route/,
  );
});

test("a failing IP resolver cannot break a route with limiting turned off", async () => {
  const server = await createServer(
    {
      redis,
      getIp: () => {
        throw new Error("resolver bug");
      },
    },
    [limited({ enabled: false })],
  );

  assert.equal((await server.inject("/")).statusCode, 200);
});

test("onExceeded returning nothing still rejects with a 429", async () => {
  const server = await createServer({ redis, max: 1, onExceeded: () => undefined });

  await server.inject("/");
  assert.equal((await server.inject("/")).statusCode, 429);
});

test("exports the store error, so callers of consume can recognize it", async () => {
  const { StoreUnavailableError } = require("../dist");
  const down = {
    defineCommand() {},
    perdiemHapiRateLimit: () => Promise.reject(new Error("down")),
  };
  const server = await createServer({ redis: down, onStoreError: "closed" });

  await assert.rejects(
    server.plugins["hapi-rate-limitor"].consume({
      key: "a",
      limits: [{ max: 1, duration: 1000 }],
    }),
    StoreUnavailableError,
  );
});
