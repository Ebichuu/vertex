const redis = require('./redis');

const SLIDING_WINDOW_CONSUME = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local count = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local current = redis.call('ZCARD', key)
local remaining = limit - current

if remaining <= 0 then
  return {0, remaining, current}
end

if count <= 0 then
  return {0, remaining, current}
end

local allowed = count
if allowed > remaining then
  allowed = remaining
end

if allowed > 0 then
  local entries = {}
  local seqKey = key .. ':seq'
  for i = 1, allowed do
    local seq = redis.call('INCR', seqKey)
    entries[#entries + 1] = now
    entries[#entries + 1] = tostring(now) .. '-' .. tostring(seq)
  end
  redis.call('ZADD', key, unpack(entries))
  redis.call('PEXPIRE', key, window + 60000)
  redis.call('PEXPIRE', seqKey, window + 60000)
  current = current + allowed
  remaining = limit - current
end

return {allowed, remaining, current}
`;

async function consume(key, limit, windowSeconds, count = 1, nowMs = Date.now()) {
  if (!key || !Number.isFinite(limit) || limit <= 0) {
    return { allowed: 0, remaining: 0, current: 0 };
  }
  const windowMs = Math.max(1, Math.floor(windowSeconds * 1000));
  const result = await redis.eval(
    SLIDING_WINDOW_CONSUME,
    1,
    key,
    nowMs,
    windowMs,
    Math.floor(limit),
    Math.floor(count)
  );
  const allowed = Number(result[0]) || 0;
  const remaining = Number(result[1]) || 0;
  const current = Number(result[2]) || 0;
  return { allowed, remaining, current };
}

async function reset(key) {
  if (!key) return;
  const seqKey = `${key}:seq`;
  await redis.del(key);
  await redis.del(seqKey);
}

module.exports = {
  consume,
  reset
};
