import "server-only";

import { isIP } from "node:net";

type Bucket = {
  tokens: number;
  updatedAt: number;
  lastSeenAt: number;
};

type GlobalRateLimitState = typeof globalThis & {
  __driftwingRateLimitBuckets?: Map<string, Bucket>;
};

export type RateLimitOptions = {
  namespace: string;
  capacity: number;
  refillPerSecond: number;
  cost?: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter: number;
  headers: Record<string, string>;
};

const globalState = globalThis as GlobalRateLimitState;
const buckets =
  globalState.__driftwingRateLimitBuckets ??
  (globalState.__driftwingRateLimitBuckets = new Map<string, Bucket>());

const STALE_BUCKET_MS = 15 * 60 * 1000;
const MAX_BUCKETS = 10_000;
let callsSinceSweep = 0;

function firstHeaderValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() ?? "";
}

function parseIp(value: string | null) {
  let candidate = firstHeaderValue(value);
  if (!candidate) return null;

  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]"));
  } else if (candidate.includes(":") && candidate.indexOf(":") === candidate.lastIndexOf(":")) {
    const withoutPort = candidate.slice(0, candidate.lastIndexOf(":"));
    if (isIP(withoutPort)) candidate = withoutPort;
  }

  return isIP(candidate) ? candidate.toLowerCase() : null;
}

/**
 * On a Cloudflare-proxied custom domain, CF-Connecting-IP identifies the
 * visitor. Vercel deployment URLs use Vercel's platform-controlled forwarding
 * header instead, preventing a caller from selecting an arbitrary bucket by
 * adding a fake Cloudflare header.
 */
export function getClientIp(request: Request) {
  let hostname = "";
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    // Next.js supplies a valid absolute URL in production.
  }

  const cloudflareIp = parseIp(request.headers.get("cf-connecting-ip"));
  const isCloudflareCustomHost =
    Boolean(cloudflareIp) &&
    Boolean(request.headers.get("cf-ray")) &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    !hostname.endsWith(".vercel.app");

  if (isCloudflareCustomHost) return cloudflareIp as string;

  return (
    parseIp(request.headers.get("x-vercel-forwarded-for")) ??
    parseIp(request.headers.get("x-forwarded-for")) ??
    parseIp(request.headers.get("x-real-ip")) ??
    cloudflareIp ??
    "unknown"
  );
}

function sweepBuckets(now: number) {
  callsSinceSweep = 0;

  for (const [key, bucket] of buckets) {
    if (now - bucket.lastSeenAt > STALE_BUCKET_MS) buckets.delete(key);
  }

  if (buckets.size <= MAX_BUCKETS) return;

  const removeCount = buckets.size - Math.floor(MAX_BUCKETS * 0.8);
  let removed = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    removed += 1;
    if (removed >= removeCount) break;
  }
}

export function checkRateLimit(request: Request, options: RateLimitOptions): RateLimitDecision {
  const now = Date.now();
  callsSinceSweep += 1;
  if (callsSinceSweep >= 200 || buckets.size > MAX_BUCKETS) sweepBuckets(now);

  const capacity = Math.max(1, options.capacity);
  const refillPerSecond = Math.max(0.001, options.refillPerSecond);
  const cost = Math.max(0.001, options.cost ?? 1);
  const key = `${options.namespace}:${getClientIp(request)}`;
  const existing = buckets.get(key);
  const elapsedSeconds = existing ? Math.max(0, now - existing.updatedAt) / 1000 : 0;
  const available = existing
    ? Math.min(capacity, existing.tokens + elapsedSeconds * refillPerSecond)
    : capacity;
  const allowed = available >= cost;
  const remainingTokens = allowed ? available - cost : available;

  buckets.set(key, {
    tokens: remainingTokens,
    updatedAt: now,
    lastSeenAt: now,
  });

  const retryAfter = allowed
    ? 0
    : Math.max(1, Math.ceil((cost - remainingTokens) / refillPerSecond));
  const secondsUntilFull = Math.ceil((capacity - remainingTokens) / refillPerSecond);
  const resetAt = Math.ceil((now + secondsUntilFull * 1000) / 1000);
  const headers: Record<string, string> = {
    "ratelimit-limit": String(capacity),
    "ratelimit-remaining": String(Math.max(0, Math.floor(remainingTokens))),
    "ratelimit-reset": String(resetAt),
  };

  if (!allowed) headers["retry-after"] = String(retryAfter);

  return {
    allowed,
    limit: capacity,
    remaining: Math.max(0, Math.floor(remainingTokens)),
    resetAt,
    retryAfter,
    headers,
  };
}
