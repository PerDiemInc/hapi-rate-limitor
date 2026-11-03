const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { RedisStore } = require("../dist/store/redis");
const { MemoryStore } = require("../dist/store/memory");
const { createRedis, namespace, sleep } = require("./helpers");

const redis = createRedis();

after(() => redis.quit());

let keyId = 0;
const keyFor = (limit) => {
  const logKey = `${namespace()}:{t}:${++keyId}`;

  return { logKey, blockKey: `${logKey}:blocked`, limit };
};

const sameSlot = (tag, limit) => {
  const logKey = `${namespace()}:{${tag}}:${++keyId}`;

  return { logKey, blockKey: `${logKey}:blocked`, limit };
};

for (const [name, create] of [
  ["redis", () => new RedisStore(redis)],
  ["memory", () => new MemoryStore()],
]) {
  describe(`${name} store`, () => {
    test("allows exactly max, then rejects with a retry time", async () => {
      const store = create();
      const key = keyFor({ max: 2, duration: 60_000 });
      const first = await store.consume([key], "hit");

      assert.deepEqual(
        [first.allowed, first.total, first.remaining, first.retryAfterMs],
        [true, 2, 1, 0],
      );
      assert.equal((await store.consume([key], "hit")).remaining, 0);

      const rejected = await store.consume([key], "hit");

      assert.equal(rejected.allowed, false);
      assert.ok(rejected.retryAfterMs > 0 && rejected.retryAfterMs <= 60_000);
    });

    test("reset is about one window ahead", async () => {
      const decision = await create().consume([keyFor({ max: 1, duration: 60_000 })], "hit");
      const ahead = decision.resetAt - Date.now();

      assert.ok(ahead > 55_000 && ahead <= 65_000, String(ahead));
    });

    test("the window slides: capacity returns as old requests age out", async () => {
      const store = create();
      const key = keyFor({ max: 1, duration: 200 });

      assert.equal((await store.consume([key], "hit")).allowed, true);
      assert.equal((await store.consume([key], "hit")).allowed, false);
      await sleep(260);
      assert.equal((await store.consume([key], "hit")).allowed, true);
    });

    test("peek reads without counting", async () => {
      const store = create();
      const key = keyFor({ max: 1, duration: 60_000 });

      assert.equal((await store.consume([key], "peek")).remaining, 1);
      assert.equal((await store.consume([key], "peek")).allowed, true);
      await store.consume([key], "hit");

      const peeked = await store.consume([key], "peek");

      assert.equal(peeked.allowed, false);
      assert.equal(peeked.remaining, 0);
    });

    test("multiple limits are all-or-nothing", async () => {
      const store = create();
      const strict = sameSlot("a", { max: 1, duration: 60_000 });
      const loose = sameSlot("a", { max: 100, duration: 60_000 });

      assert.equal((await store.consume([strict, loose], "hit")).remaining, 0);

      const rejected = await store.consume([strict, loose], "hit");

      assert.equal(rejected.allowed, false);
      assert.equal(rejected.total, 1);
      // A rejected request must not spend the budget of the limit that passed.
      assert.equal((await store.consume([loose], "peek")).remaining, 99);
    });

    test("reports the tightest limit while allowed", async () => {
      const decision = await create().consume(
        [
          sameSlot("b", { max: 100, duration: 60_000 }),
          sameSlot("b", { max: 5, duration: 60_000 }),
        ],
        "hit",
      );

      assert.deepEqual([decision.total, decision.remaining], [5, 4]);
    });

    test("blockMs keeps rejecting after the window ends", async () => {
      const store = create();
      const key = keyFor({ max: 1, duration: 100, blockMs: 500 });

      await store.consume([key], "hit");

      const rejected = await store.consume([key], "hit");

      assert.equal(rejected.allowed, false);
      assert.ok(rejected.retryAfterMs > 300);
      await sleep(200);
      assert.equal((await store.consume([key], "hit")).allowed, false);
      await sleep(400);
      assert.equal((await store.consume([key], "hit")).allowed, true);
    });

    test("without countRejected a retrying client recovers after the window", async () => {
      const store = create();
      const key = keyFor({ max: 1, duration: 200 });

      await store.consume([key], "hit");

      for (let i = 0; i < 3; i++) {
        await sleep(40);
        assert.equal((await store.consume([key], "hit")).allowed, false);
      }

      await sleep(120);
      assert.equal((await store.consume([key], "hit")).allowed, true);
    });

    test("countRejected keeps a retrying client limited until it backs off", async () => {
      const store = create();
      const key = keyFor({ max: 1, duration: 200, countRejected: true });

      await store.consume([key], "hit");

      for (let i = 0; i < 8; i++) {
        await sleep(50);
        assert.equal((await store.consume([key], "hit")).allowed, false);
      }

      await sleep(260);
      assert.equal((await store.consume([key], "hit")).allowed, true);
    });

    test("concurrent requests never exceed max", async () => {
      const store = create();
      const key = keyFor({ max: 25, duration: 60_000 });
      const results = await Promise.all(
        Array.from({ length: 200 }, () => store.consume([key], "hit")),
      );

      assert.equal(results.filter((result) => result.allowed).length, 25);
    });
  });
}

test("redis memory per client stays bounded under attack", async () => {
  const store = new RedisStore(redis);
  const key = keyFor({ max: 5, duration: 60_000, countRejected: true });

  await Promise.all(Array.from({ length: 300 }, () => store.consume([key], "hit")));

  assert.equal(await redis.zcard(key.logKey), 5);
});

test("redis keys expire, so abandoned clients cost nothing", async () => {
  const store = new RedisStore(redis);
  const key = keyFor({ max: 5, duration: 1_000 });

  await store.consume([key], "hit");

  const ttl = await redis.pttl(key.logKey);

  assert.ok(ttl > 0 && ttl <= 1_000, String(ttl));
});

test("the block key expires on its own", async () => {
  const store = new RedisStore(redis);
  const key = keyFor({ max: 1, duration: 1_000, blockMs: 5_000 });

  await store.consume([key], "hit");
  await store.consume([key], "hit");

  const ttl = await redis.pttl(key.blockKey);

  assert.ok(ttl > 0 && ttl <= 5_000, String(ttl));
});

test("the memory store evicts the least recently used key at its bound", async () => {
  const store = new MemoryStore(2);
  const limit = { max: 1, duration: 60_000 };
  const [a, b, c] = [keyFor(limit), keyFor(limit), keyFor(limit)];

  await store.consume([a], "hit");
  await store.consume([b], "hit");
  await store.consume([c], "hit");

  assert.equal(store.entries.size, 2);
  assert.equal((await store.consume([b], "hit")).allowed, false);
  assert.equal((await store.consume([a], "peek")).allowed, true);
});

test("redis and memory agree over random traffic", async () => {
  const limits = [
    { max: 3, duration: 60_000 },
    { max: 7, duration: 60_000 },
    { max: 2, duration: 60_000, countRejected: true },
  ];
  const redisStore = new RedisStore(redis);
  const memoryStore = new MemoryStore();
  let state = 12345;
  const random = (range) => {
    state = (state * 1103515245 + 12345) % 2147483648;

    return state % range;
  };

  for (let round = 0; round < 40; round++) {
    const keys = limits.map((limit) => sameSlot(`p${round}`, limit));

    for (let step = 0; step < 25; step++) {
      const subset = keys.filter(() => random(2) === 0);
      const chosen = subset.length > 0 ? subset : [keys[0]];
      const mode = random(4) === 0 ? "peek" : "hit";
      const [fromRedis, fromMemory] = await Promise.all([
        redisStore.consume(chosen, mode),
        memoryStore.consume(chosen, mode),
      ]);

      assert.deepEqual(
        [fromRedis.allowed, fromRedis.total, fromRedis.remaining],
        [fromMemory.allowed, fromMemory.total, fromMemory.remaining],
        `round ${round}, step ${step}`,
      );
    }
  }
});

for (const [name, create] of [
  ["redis", () => new RedisStore(redis)],
  ["memory", () => new MemoryStore()],
]) {
  test(`${name} store releases only the named request`, async () => {
    const store = create();
    const key = keyFor({ max: 2, duration: 60_000 });

    await store.consume([key], "hit", "first");
    await store.consume([key], "hit", "second");
    assert.equal((await store.consume([key], "hit")).allowed, false);

    await store.release([key], "unknown");
    assert.equal((await store.consume([key], "peek")).allowed, false);

    await store.release([key], "first");
    assert.equal((await store.consume([key], "peek")).remaining, 1);
  });
}
