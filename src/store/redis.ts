import { randomBytes } from "node:crypto";
import type { Decision, LimitKey, RedisClient, Store, StoreMode } from "../types";

const COMMAND_NAME = "perdiemHapiRateLimit";
const ARGS_PER_LIMIT = 4;

/**
 * Applies every limit atomically: all of them count the request, or none do. It uses
 * Redis' clock, so servers with drifting clocks agree on the window. Each log holds at
 * most `max` entries, so memory per client is bounded.
 */
const SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local mode = ARGV[1]
local member = ARGV[2]
local limitCount = tonumber(ARGV[3])
local allowed = 1
local states = {}

if mode == 'release' then
  for i = 1, limitCount do
    redis.call('ZREM', KEYS[i * 2 - 1], member)
  end

  return { 1, 0, 0, 0, 0 }
end

for i = 1, limitCount do
  local offset = 3 + (i - 1) * ${ARGS_PER_LIMIT}
  local state = {
    log = KEYS[i * 2 - 1],
    block = KEYS[i * 2],
    max = tonumber(ARGV[offset + 1]),
    duration = tonumber(ARGV[offset + 2]),
    blockMs = tonumber(ARGV[offset + 3]),
    countRejected = ARGV[offset + 4] == '1'
  }

  redis.call('ZREMRANGEBYSCORE', state.log, '-inf', now - state.duration)
  state.used = redis.call('ZCARD', state.log)
  state.blockedMs = math.max(redis.call('PTTL', state.block), 0)
  state.rejected = state.used >= state.max or state.blockedMs > 0

  if state.rejected then
    allowed = 0
  end

  states[i] = state
end

if mode == 'hit' then
  for i = 1, limitCount do
    local state = states[i]

    if allowed == 1 or state.countRejected then
      redis.call('ZADD', state.log, now, member)
      redis.call('ZREMRANGEBYRANK', state.log, 0, -(state.max + 1))
      redis.call('PEXPIRE', state.log, state.duration)
      state.used = redis.call('ZCARD', state.log)
    end

    if allowed == 0 and state.rejected and state.blockMs > 0 and state.blockedMs == 0 then
      redis.call('SET', state.block, '1', 'PX', state.blockMs)
      state.blockedMs = state.blockMs
    end
  end
end

local chosen = nil

for i = 1, limitCount do
  local state = states[i]
  local oldest = redis.call('ZRANGE', state.log, 0, 0, 'WITHSCORES')
  local windowResetAt = now + state.duration

  if oldest[2] then
    windowResetAt = tonumber(oldest[2]) + state.duration
  end

  state.remaining = 0

  if state.blockedMs == 0 then
    state.remaining = math.max(0, state.max - state.used)
  end

  state.resetAt = math.max(windowResetAt, now + state.blockedMs)
  state.retryAfter = 0

  if state.rejected then
    local windowRetry = 0

    if state.used >= state.max then
      windowRetry = windowResetAt - now
    end

    state.retryAfter = math.max(1, state.blockedMs, windowRetry)
  end

  if chosen == nil then
    chosen = state
  elseif allowed == 1 then
    if state.remaining < chosen.remaining then
      chosen = state
    end
  elseif state.rejected ~= chosen.rejected then
    if state.rejected then
      chosen = state
    end
  elseif state.retryAfter > chosen.retryAfter then
    chosen = state
  end
end

return { allowed, chosen.max, chosen.remaining, chosen.resetAt, chosen.retryAfter }
`;

type RateLimitCommand = (...args: Array<string | number>) => Promise<number[]>;

/** Detected by shape: `instanceof` fails when an app's ioredis differs from ours. */
export function isRedisClient(value: unknown): value is RedisClient {
  return typeof (value as RedisClient | null | undefined)?.defineCommand === "function";
}

export class RedisStore implements Store {
  private readonly memberPrefix = randomBytes(8).toString("hex");
  private sequence = 0;

  constructor(private readonly client: RedisClient) {
    client.defineCommand(COMMAND_NAME, { lua: SCRIPT });
  }

  async consume(
    keys: LimitKey[],
    mode: StoreMode,
    // Unique per request, because two requests in one millisecond must both count.
    member = `${this.memberPrefix}:${++this.sequence}`,
  ): Promise<Decision> {
    const [allowed, total, remaining, resetAt, retryAfterMs] = await this.run(keys, mode, member);

    return { allowed: allowed === 1, total, remaining, resetAt, retryAfterMs };
  }

  async release(keys: LimitKey[], member: string): Promise<void> {
    await this.run(keys, "release", member);
  }

  private async run(
    keys: LimitKey[],
    mode: StoreMode | "release",
    member: string,
  ): Promise<[number, number, number, number, number]> {
    const command = (this.client as unknown as Record<string, RateLimitCommand>)[
      COMMAND_NAME
    ] as RateLimitCommand;
    const args: Array<string | number> = [
      keys.length * 2,
      ...keys.flatMap(({ logKey, blockKey }) => [logKey, blockKey]),
      mode,
      member,
      keys.length,
      ...keys.flatMap(({ limit }) => [
        limit.max,
        limit.duration,
        limit.blockMs ?? 0,
        limit.countRejected ? "1" : "0",
      ]),
    ];

    return (await command.apply(this.client, args)) as [number, number, number, number, number];
  }
}
