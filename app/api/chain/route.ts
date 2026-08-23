import { NextRequest, NextResponse } from "next/server";
import { encodeFunctionData, isAddress } from "viem";
import { privateBaseRpcRequest } from "@/lib/server/baseRpc";
import { scoreboardAbi } from "@/lib/scoreboardAbi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]+$/;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 180;

type RateLimitBucket = { count: number; resetAt: number };

declare global {
  // Best-effort per-instance protection. Vercel Firewall should provide the
  // distributed rate limit when stricter abuse protection is required.
  // eslint-disable-next-line no-var
  var __dwChainApiRateLimits: Map<string, RateLimitBucket> | undefined;
}

const rateLimits =
  globalThis.__dwChainApiRateLimits ||
  (globalThis.__dwChainApiRateLimits = new Map<string, RateLimitBucket>());

const responseHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
};

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...responseHeaders, ...extraHeaders },
  });
}

function requestIp(req: NextRequest) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function applyRateLimit(req: NextRequest) {
  const now = Date.now();
  const key = requestIp(req);
  let bucket = rateLimits.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimits.set(key, bucket);
  }

  bucket.count += 1;

  // Prevent unbounded memory growth on a long-lived server instance.
  if (rateLimits.size > 5_000) {
    for (const [bucketKey, value] of rateLimits) {
      if (value.resetAt <= now) rateLimits.delete(bucketKey);
    }
  }

  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - bucket.count);
  const headers = {
    "ratelimit-limit": String(RATE_LIMIT_MAX_REQUESTS),
    "ratelimit-remaining": String(remaining),
    "ratelimit-reset": String(Math.ceil(bucket.resetAt / 1000)),
  };

  return {
    allowed: bucket.count <= RATE_LIMIT_MAX_REQUESTS,
    headers,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function isSameOriginRequest(req: NextRequest) {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;

  const origin = req.headers.get("origin");
  if (!origin) return true;

  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return json({ error: "Cross-origin requests are not allowed" }, 403);
  }

  const rateLimit = applyRateLimit(req);
  if (!rateLimit.allowed) {
    return json(
      { error: "Too many requests" },
      429,
      { ...rateLimit.headers, "retry-after": String(rateLimit.retryAfter) }
    );
  }

  const operation = req.nextUrl.searchParams.get("operation");

  try {
    if (operation === "bestScore") {
      const player = req.nextUrl.searchParams.get("player") || "";
      if (!isAddress(player, { strict: true })) {
        return json({ error: "Invalid player address" }, 400, rateLimit.headers);
      }

      const scoreboardAddress = process.env.NEXT_PUBLIC_SCOREBOARD_ADDRESS;
      if (!scoreboardAddress || !isAddress(scoreboardAddress, { strict: true })) {
        return json({ error: "Score saving is not configured" }, 503, rateLimit.headers);
      }

      const data = encodeFunctionData({
        abi: scoreboardAbi,
        functionName: "bestScore",
        args: [player],
      });
      const encodedScore = await privateBaseRpcRequest<string>("eth_call", [
        { to: scoreboardAddress, data },
        "latest",
      ]);
      if (!HEX_PATTERN.test(encodedScore)) {
        throw new Error("Invalid RPC response");
      }
      const score = BigInt(encodedScore);

      return json({ score: score.toString() }, 200, rateLimit.headers);
    }

    if (operation === "receipt") {
      const hash = req.nextUrl.searchParams.get("hash") || "";
      if (!HASH_PATTERN.test(hash)) {
        return json({ error: "Invalid transaction hash" }, 400, rateLimit.headers);
      }

      const receipt = await privateBaseRpcRequest<{
        status?: string;
        blockNumber?: string;
      } | null>("eth_getTransactionReceipt", [hash]);

      if (!receipt) {
        return json({ status: "pending" }, 202, rateLimit.headers);
      }

      if (
        !receipt.status ||
        !HEX_PATTERN.test(receipt.status) ||
        !receipt.blockNumber ||
        !HEX_PATTERN.test(receipt.blockNumber)
      ) {
        throw new Error("Invalid RPC response");
      }

      return json(
        {
          status: BigInt(receipt.status) === 1n ? "success" : "reverted",
          blockNumber: BigInt(receipt.blockNumber).toString(),
        },
        200,
        rateLimit.headers
      );
    }

    return json({ error: "Unsupported operation" }, 400, rateLimit.headers);
  } catch (error) {
    // Do not return the upstream error message: provider errors can contain
    // the private RPC URL. Log only the error type for diagnostics.
    console.error(
      "[chain-api] Private RPC request failed:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return json({ error: "Blockchain service is temporarily unavailable" }, 502, rateLimit.headers);
  }
}
