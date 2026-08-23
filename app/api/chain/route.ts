import { NextRequest, NextResponse } from "next/server";
import { encodeFunctionData, isAddress } from "viem";
import { privateBaseRpcRequest } from "@/lib/server/baseRpc";
import { checkRateLimit, type RateLimitDecision } from "@/lib/server/rateLimit";
import { scoreboardAbi } from "@/lib/scoreboardAbi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]+$/;

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

function tooManyRequests(limit: RateLimitDecision) {
  return json(
    { error: "Too many requests. Please wait a moment and try again." },
    429,
    limit.headers,
  );
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
  const overallLimit = checkRateLimit(req, {
    namespace: "chain:all",
    capacity: 60,
    refillPerSecond: 1.5,
  });
  if (!overallLimit.allowed) return tooManyRequests(overallLimit);

  if (!isSameOriginRequest(req)) {
    return json(
      { error: "Cross-origin requests are not allowed" },
      403,
      overallLimit.headers,
    );
  }

  const operation = req.nextUrl.searchParams.get("operation");
  const operationLimit = checkRateLimit(req, {
    namespace:
      operation === "bestScore"
        ? "chain:best-score"
        : operation === "receipt"
          ? "chain:receipt"
          : "chain:invalid",
    capacity: operation === "bestScore" ? 15 : operation === "receipt" ? 40 : 10,
    refillPerSecond: operation === "bestScore" ? 0.25 : operation === "receipt" ? 1 : 0.1,
  });
  if (!operationLimit.allowed) return tooManyRequests(operationLimit);
  const rateHeaders = operationLimit.headers;

  try {
    if (operation === "bestScore") {
      const player = req.nextUrl.searchParams.get("player") || "";
      if (!isAddress(player, { strict: true })) {
        return json({ error: "Invalid player address" }, 400, rateHeaders);
      }

      const scoreboardAddress = process.env.NEXT_PUBLIC_SCOREBOARD_ADDRESS;
      if (!scoreboardAddress || !isAddress(scoreboardAddress, { strict: true })) {
        return json({ error: "Score saving is not configured" }, 503, rateHeaders);
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

      return json({ score: score.toString() }, 200, rateHeaders);
    }

    if (operation === "receipt") {
      const hash = req.nextUrl.searchParams.get("hash") || "";
      if (!HASH_PATTERN.test(hash)) {
        return json({ error: "Invalid transaction hash" }, 400, rateHeaders);
      }

      const receipt = await privateBaseRpcRequest<{
        status?: string;
        blockNumber?: string;
      } | null>("eth_getTransactionReceipt", [hash]);

      if (!receipt) {
        return json({ status: "pending" }, 202, rateHeaders);
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
        rateHeaders
      );
    }

    return json({ error: "Unsupported operation" }, 400, rateHeaders);
  } catch (error) {
    // Do not return the upstream error message: provider errors can contain
    // the private RPC URL. Log only the error type for diagnostics.
    console.error(
      "[chain-api] Private RPC request failed:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return json({ error: "Blockchain service is temporarily unavailable" }, 502, rateHeaders);
  }
}
