import { checkRateLimit, type RateLimitDecision } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const ALLOWED_METHODS = new Set([
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "eth_chainId",
  "eth_supportedEntryPoints",
  "eth_estimateUserOperationGas",
  "eth_sendUserOperation",
  "eth_getUserOperationByHash",
  "eth_getUserOperationReceipt",
]);

type JsonRpcCall = {
  jsonrpc?: unknown;
  method?: unknown;
  params?: unknown;
};

function corsHeaders(origin: string | null) {
  let allowedOrigin = "*";
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        allowedOrigin = parsed.origin;
      }
    } catch {
      // Invalid origins do not need to be reflected.
    }
  }

  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers":
      "ratelimit-limit,ratelimit-remaining,ratelimit-reset,retry-after",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function jsonResponse(
  req: Request,
  payload: unknown,
  status: number,
  limit?: RateLimitDecision,
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...corsHeaders(req.headers.get("origin")),
      ...(limit?.headers ?? {}),
    },
  });
}

function rateLimited(req: Request, limit: RateLimitDecision) {
  return jsonResponse(
    req,
    { error: "Too many requests. Please wait a moment and try again." },
    429,
    limit,
  );
}

function isValidJsonRpcCall(value: unknown): value is JsonRpcCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const call = value as JsonRpcCall;
  if (call.jsonrpc !== "2.0" || typeof call.method !== "string") return false;
  if (!ALLOWED_METHODS.has(call.method)) return false;
  if (
    call.params !== undefined &&
    !Array.isArray(call.params) &&
    (typeof call.params !== "object" || call.params === null)
  ) {
    return false;
  }
  return true;
}

export async function OPTIONS(req: Request) {
  const limit = checkRateLimit(req, {
    namespace: "paymaster:preflight",
    capacity: 120,
    refillPerSecond: 2,
  });
  if (!limit.allowed) return rateLimited(req, limit);

  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), ...limit.headers },
  });
}

export async function POST(req: Request) {
  const requestLimit = checkRateLimit(req, {
    namespace: "paymaster:requests",
    capacity: 40,
    refillPerSecond: 0.75,
  });
  if (!requestLimit.allowed) return rateLimited(req, requestLimit);

  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return jsonResponse(
      req,
      { error: "Content-Type must be application/json" },
      415,
      requestLimit,
    );
  }

  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonResponse(req, { error: "Request body is too large" }, 413, requestLimit);
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return jsonResponse(req, { error: "Unable to read request body" }, 400, requestLimit);
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(req, { error: "Request body is too large" }, 413, requestLimit);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return jsonResponse(req, { error: "Invalid JSON body" }, 400, requestLimit);
  }

  const calls = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  if (calls.length === 0 || calls.length > 5 || !calls.every(isValidJsonRpcCall)) {
    return jsonResponse(req, { error: "Unsupported JSON-RPC request" }, 400, requestLimit);
  }

  const rpcLimit = checkRateLimit(req, {
    namespace: "paymaster:rpc",
    capacity: 30,
    refillPerSecond: 0.5,
    cost: calls.length,
  });
  if (!rpcLimit.allowed) return rateLimited(req, rpcLimit);

  const target = process.env.CDP_PAYMASTER_URL;
  if (!target) {
    return jsonResponse(req, { error: "Paymaster proxy is not configured" }, 503, rpcLimit);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return jsonResponse(
      req,
      { error: timedOut ? "Paymaster request timed out" : "Paymaster request failed" },
      timedOut ? 504 : 502,
      rpcLimit,
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseBody = await upstream.arrayBuffer();
  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...corsHeaders(req.headers.get("origin")),
      ...rpcLimit.headers,
    },
  });
}
