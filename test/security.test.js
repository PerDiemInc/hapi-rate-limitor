const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { createRedis, createServer, statuses, times, namespace } = require("./helpers");

const redis = createRedis();

after(() => redis.quit());

const postLimited = (options, path = "/send") => ({
  method: "POST",
  path,
  options: { plugins: { "hapi-rate-limitor": options } },
  handler: () => "sent",
});

const send = (phone, remoteAddress = "10.0.0.1") => ({
  method: "POST",
  url: "/send",
  payload: { phone },
  remoteAddress,
});

test("rotating spoofable headers does not evade the limit", async () => {
  const server = await createServer({ redis, max: 2 });
  const requests = times(6, (i) => ({
    url: "/",
    headers: {
      "x-forwarded-for": `9.9.9.${i}`,
      "x-client-ip": `9.9.8.${i}`,
      "x-real-ip": `9.9.7.${i}`,
      "true-client-ip": `9.9.6.${i}`,
      "cf-connecting-ip": `9.9.5.${i}`,
    },
  }));

  assert.deepEqual(await statuses(server, requests), [200, 200, 429, 429, 429, 429]);
});

test("the CloudFront header identifies the client by default", async () => {
  const server = await createServer({ redis, max: 1 });
  const from = (address) => ({ url: "/", headers: { "cloudfront-viewer-address": address } });

  assert.deepEqual(
    await statuses(server, [from("1.1.1.1:1000"), from("2.2.2.2:1000"), from("1.1.1.1:2000")]),
    [200, 200, 429],
  );
});

test("a guard stops a direct caller from choosing its identity", async () => {
  const server = await createServer({
    redis,
    max: 1,
    ipSources: [
      {
        header: "cloudfront-viewer-address",
        hasPort: true,
        when: (request) => request.headers["x-origin-secret"] === "expected",
      },
    ],
  });
  const direct = (i) => ({
    url: "/",
    remoteAddress: "6.6.6.6",
    headers: { "cloudfront-viewer-address": `9.9.9.${i}:443` },
  });

  assert.deepEqual(await statuses(server, times(3, direct)), [200, 429, 429]);
});

test("spoofed headers cannot match the allowlist", async () => {
  const server = await createServer({ redis, max: 1, allowlist: ["8.8.8.8"] });
  const request = {
    url: "/",
    remoteAddress: "6.6.6.6",
    headers: { "x-forwarded-for": "8.8.8.8", "x-client-ip": "8.8.8.8" },
  };

  assert.deepEqual(await statuses(server, [request, request]), [200, 429]);
});

test("the allowlist supports addresses and CIDR ranges on both families", async () => {
  const server = await createServer({
    redis,
    max: 1,
    allowlist: ["8.8.8.8", "10.1.0.0/16", "2001:db8::/32", "::1"],
  });

  for (const remoteAddress of ["8.8.8.8", "10.1.200.3", "2001:db8:5::1", "::1"]) {
    assert.deepEqual(
      await statuses(server, times(3, { url: "/", remoteAddress })),
      [200, 200, 200],
      remoteAddress,
    );
  }

  assert.deepEqual(
    await statuses(server, times(2, { url: "/", remoteAddress: "10.2.0.1" })),
    [200, 429],
  );
});

test("an IPv6 client rotating inside its /64 stays limited", async () => {
  const server = await createServer({ redis, max: 2, ipSources: [{ header: "x-ip" }] });
  const requests = times(5, (i) => ({ url: "/", headers: { "x-ip": `2001:db8:1:2::${i + 1}` } }));

  assert.deepEqual(await statuses(server, requests), [200, 200, 429, 429, 429]);
});

test("an attacker cannot inject Redis key syntax or huge keys through a resolver", async () => {
  const hostile = ["{slot}", "a b\r\nFLUSHALL", "x".repeat(100_000), "}{", "*", "\u0000"];

  for (const value of hostile) {
    const ns = namespace();
    const server = await createServer({ redis, namespace: ns, max: 5, getIp: () => value });

    assert.equal((await server.inject("/")).statusCode, 200);

    const [key] = await redis.keys(`${ns}:*`);

    assert.ok(key.length < 300, `key length ${key.length}`);
    assert.equal((key.match(/\{/g) ?? []).length, 1);
  }
});

test("SMS pumping: rotating IPs cannot keep texting one phone", async () => {
  const server = await createServer({ redis }, [
    postLimited({
      limits: [
        { max: 100, duration: 60_000 },
        { max: 3, duration: 60_000, by: (request) => request.payload?.phone },
      ],
    }),
  ]);
  const requests = times(6, (i) => send("+15550100", `20.0.0.${i}`));

  assert.deepEqual(await statuses(server, requests), [200, 200, 200, 429, 429, 429]);
});

test("SMS pumping: one client cannot text many phones", async () => {
  const server = await createServer({ redis }, [
    postLimited({
      limits: [
        { max: 2, duration: 60_000 },
        { max: 5, duration: 60_000, by: (request) => request.payload?.phone },
      ],
    }),
  ]);
  const requests = times(5, (i) => send(`+1555010${i}`));

  assert.deepEqual(await statuses(server, requests), [200, 200, 429, 429, 429]);
});

test("SMS pumping: a botnet hits the per-number-prefix cap", async () => {
  const server = await createServer({ redis }, [
    postLimited({
      limits: [
        { max: 100, duration: 60_000 },
        { max: 100, duration: 60_000, by: (request) => request.payload?.phone },
        { max: 3, duration: 60_000, by: (request) => request.payload?.phone?.slice(0, 6) },
      ],
    }),
  ]);
  const requests = times(6, (i) =>
    send(`+88123${i}000`.replace(/^(.{6}).*/, `$1${i}000`), `30.0.0.${i}`),
  );

  assert.deepEqual(await statuses(server, requests), [200, 200, 200, 429, 429, 429]);
});

test("SMS pumping: a per-store budget caps total spend", async () => {
  const route = {
    method: "POST",
    path: "/stores/{store_id}/send",
    options: {
      plugins: {
        "hapi-rate-limitor": {
          limits: [{ max: 2, duration: 60_000, by: (request) => request.params.store_id }],
        },
      },
    },
    handler: () => "sent",
  };
  const server = await createServer({ redis }, [route]);
  const to = (store, i) => ({
    method: "POST",
    url: `/stores/${store}/send`,
    remoteAddress: `40.0.0.${i}`,
  });

  assert.deepEqual(
    await statuses(server, [to("a", 1), to("a", 2), to("a", 3), to("b", 4)]),
    [200, 200, 429, 200],
  );
});

test("rejected requests do not spend a phone number budget", async () => {
  const server = await createServer({ redis }, [
    postLimited({
      limits: [
        { max: 1, duration: 60_000 },
        { max: 1, duration: 60_000, by: (request) => request.payload?.phone },
      ],
    }),
  ]);

  // The attacker is out of its own budget, so this must not lock the victim's number.
  assert.deepEqual(
    await statuses(server, [send("+15550001", "50.0.0.1"), send("+15550002", "50.0.0.1")]),
    [200, 429],
  );
  assert.equal((await server.inject(send("+15550002", "50.0.0.2"))).statusCode, 200);
});

test("phone numbers never appear in Redis keys", async () => {
  const ns = namespace();
  const phone = "+15557654321";
  const server = await createServer({ redis, namespace: ns }, [
    postLimited({
      limits: [{ max: 5, duration: 60_000, by: (request) => request.payload?.phone }],
    }),
  ]);

  await server.inject(send(phone));

  const keys = await redis.keys(`${ns}:*`);

  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes(phone) && !keys[0].includes("5557654321"), keys[0]);
});

test("a missing `by` value counts by client instead of skipping the limit", async () => {
  const server = await createServer({ redis }, [
    postLimited({
      limits: [{ max: 1, duration: 60_000, by: (request) => request.payload?.phone }],
    }),
  ]);
  const noPhone = { method: "POST", url: "/send", payload: {} };

  assert.deepEqual(await statuses(server, [noPhone, noPhone]), [200, 429]);
});

test("blockMs locks out an OTP abuser after the limit", async () => {
  const server = await createServer({ redis }, [
    postLimited({ max: 1, duration: 100, blockMs: 60_000 }),
  ]);
  const request = { method: "POST", url: "/send" };

  await statuses(server, [request, request]);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const response = await server.inject(request);

  assert.equal(response.statusCode, 429);
  assert.ok(Number(response.headers["retry-after"]) > 50);
});

test("failed logins lock out the client, successful ones do not count", async () => {
  let password = "wrong";
  const route = {
    method: "POST",
    path: "/login",
    options: { plugins: { "hapi-rate-limitor": { authFailures: { max: 2, duration: 60_000 } } } },
    handler: (_request, h) => (password === "right" ? "welcome" : h.response("no").code(401)),
  };
  const server = await createServer({ redis, max: 1000 }, [route]);
  const login = { method: "POST", url: "/login" };

  password = "right";
  assert.deepEqual(await statuses(server, times(5, login)), times(5, 200));

  password = "wrong";
  assert.deepEqual(await statuses(server, times(4, login)), [401, 401, 429, 429]);

  const other = await server.inject({ ...login, remoteAddress: "60.0.0.1" });

  assert.equal(other.statusCode, 401);
});

test("failed auth from the auth scheme is counted before auth runs again", async () => {
  let authCalls = 0;
  const setup = (server) => {
    server.auth.scheme("reject", () => ({
      authenticate: () => {
        authCalls++;
        throw Object.assign(new Error("Unauthorized"), {
          isBoom: true,
          isServer: false,
          output: {
            statusCode: 401,
            payload: { statusCode: 401, error: "Unauthorized", message: "no" },
            headers: {},
          },
          reformat() {},
        });
      },
    }));
    server.auth.strategy("reject", "reject");
  };
  const route = { method: "GET", path: "/", options: { auth: "reject", handler: () => "ok" } };
  const server = await createServer(
    { redis, authFailures: { max: 2, duration: 60_000 } },
    [route],
    setup,
  );

  assert.deepEqual(await statuses(server, times(5, "/")), [401, 401, 429, 429, 429]);
  assert.equal(authCalls, 2);
});

test("custom auth failure codes and the allowlist are honored", async () => {
  const route = { method: "GET", path: "/", handler: (_request, h) => h.response("no").code(403) };
  const server = await createServer(
    {
      redis,
      allowlist: ["70.0.0.1"],
      authFailures: { max: 1, duration: 60_000, statusCodes: [403] },
    },
    [route],
  );

  assert.deepEqual(await statuses(server, times(2, "/")), [403, 429]);
  assert.deepEqual(
    await statuses(server, times(2, { url: "/", remoteAddress: "70.0.0.1" })),
    [403, 403],
  );
});

test("no secret or client data reaches the 429 body", async () => {
  const server = await createServer({ redis, max: 1 });

  await server.inject({ url: "/", headers: { cookie: "session=secret" } });

  const response = await server.inject({ url: "/", headers: { cookie: "session=secret" } });

  assert.ok(!response.payload.includes("secret"));
  assert.ok(!response.payload.includes("127.0.0.1"));
});

test("a route can override getRouteKey, so sensitive routes can\u2019t be varied", async () => {
  const route = (path, options) => ({
    method: "GET",
    path,
    options: { plugins: { "hapi-rate-limitor": options } },
    handler: () => "ok",
  });
  const server = await createServer({ redis, getRouteKey: (request) => request.path }, [
    route("/a/{id}", { max: 1 }),
    route("/otp/{id}", { max: 1, getRouteKey: (request) => request.route.path }),
  ]);

  assert.deepEqual(await statuses(server, ["/a/1", "/a/2"]), [200, 200]);
  assert.deepEqual(await statuses(server, ["/otp/1", "/otp/2"]), [200, 429]);
});

test("consume counts events outside a request, atomically and without storing the key", async () => {
  const ns = namespace();
  const server = await createServer({ redis, namespace: ns });
  const { consume } = server.plugins["hapi-rate-limitor"];
  const key = "sms:phone:+15557654321";
  const limits = [
    { max: 2, duration: 60_000 },
    { max: 5, duration: 60_000 },
  ];
  const results = await Promise.all(times(6, () => consume({ key, limits })));

  assert.equal(results.filter((result) => result.isInQuota()).length, 2);
  assert.equal(results[0].total, 2);

  const keys = await redis.keys(`${ns}:*`);

  assert.ok(keys.length > 0);
  assert.ok(
    keys.every((stored) => !stored.includes("5557654321")),
    keys.join(),
  );
  await assert.rejects(consume({ key, limits: [{ max: 0, duration: 1 }] }), /hapi-rate-limitor/);
});

test("parallel guesses cannot exceed the failed login cap", async () => {
  let attempts = 0;
  const route = {
    method: "POST",
    path: "/login",
    options: { plugins: { "hapi-rate-limitor": { authFailures: { max: 5, duration: 60_000 } } } },
    handler: async (_request, h) => {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 20));

      return h.response("no").code(401);
    },
  };
  const server = await createServer({ redis, max: 100_000 }, [route]);
  const responses = await Promise.all(
    times(200, () => server.inject({ method: "POST", url: "/login" })),
  );

  assert.equal(attempts, 5);
  assert.equal(responses.filter((response) => response.statusCode === 401).length, 5);
  assert.equal(responses.filter((response) => response.statusCode === 429).length, 195);
});

test("successful logins give their slot back, even in parallel", async () => {
  const route = {
    method: "POST",
    path: "/login",
    options: { plugins: { "hapi-rate-limitor": { authFailures: { max: 3, duration: 60_000 } } } },
    handler: () => "ok",
  };
  const server = await createServer({ redis, max: 100_000 }, [route]);

  for (let round = 0; round < 4; round++) {
    const responses = await Promise.all(
      times(3, () => server.inject({ method: "POST", url: "/login" })),
    );

    assert.deepEqual(
      responses.map((response) => response.statusCode),
      [200, 200, 200],
    );
  }
});

test("a resolver that fails after authentication cannot turn a 401 into a 500", async () => {
  const route = {
    method: "POST",
    path: "/login",
    options: { plugins: { "hapi-rate-limitor": { authFailures: { max: 3, duration: 60_000 } } } },
    handler: (_request, h) => h.response("no").code(401),
  };
  let calls = 0;
  const server = await createServer(
    {
      redis,
      extensionPoint: "onPreAuth",
      getRouteKey: () => {
        calls++;

        return "fixed";
      },
    },
    [route],
  );

  assert.equal((await server.inject({ method: "POST", url: "/login" })).statusCode, 401);
  assert.equal(calls, 1);
});

test("the IP resolver can depend on authentication at each step", async () => {
  const seen = [];
  const route = {
    method: "GET",
    path: "/",
    options: { plugins: { "hapi-rate-limitor": { authFailures: { max: 5, duration: 60_000 } } } },
    handler: () => "ok",
  };
  const server = await createServer(
    {
      redis,
      getIp: (request) => {
        seen.push(request.auth.isAuthenticated);

        return "1.1.1.1";
      },
    },
    [route],
  );

  await server.inject("/");

  assert.ok(seen.length >= 2, String(seen.length));
});

test("IPv4-mapped addresses from getIp are not all one client", async () => {
  let ip = "::ffff:1.2.3.4";
  const server = await createServer({ redis, max: 1, getIp: () => ip });

  assert.equal((await server.inject("/")).statusCode, 200);
  ip = "::ffff:5.6.7.8";
  assert.equal((await server.inject("/")).statusCode, 200);
  assert.equal((await server.inject("/")).statusCode, 429);
});

test("earlyLimit counts requests that later steps would reject", async () => {
  const route = {
    method: "POST",
    path: "/",
    options: {
      payload: { maxBytes: 10 },
      handler: () => "ok",
    },
  };
  const server = await createServer(
    { redis, max: 100_000, earlyLimit: { max: 3, duration: 60_000 } },
    [route],
  );
  const requests = [
    "/missing",
    { method: "POST", url: "/", payload: "x".repeat(100) },
    { method: "POST", url: "/" },
    "/missing",
    { method: "POST", url: "/" },
  ];

  assert.deepEqual(await statuses(server, requests), [404, 413, 200, 429, 429]);
  assert.ok(Number((await server.inject("/missing")).headers["retry-after"]) > 0);
});

test("earlyLimit honors skip and the allowlist", async () => {
  const server = await createServer({
    redis,
    allowlist: ["80.0.0.1"],
    earlyLimit: { max: 1, duration: 60_000 },
    max: 100_000,
    skip: (request) => request.path === "/health",
  });

  assert.deepEqual(await statuses(server, times(3, "/health")), [404, 404, 404]);
  assert.deepEqual(
    await statuses(server, times(2, { url: "/", remoteAddress: "80.0.0.1" })),
    [200, 200],
  );
  assert.deepEqual(await statuses(server, times(2, "/")), [200, 429]);
});
