import "server-only";

const RPC_TIMEOUT_MS = 12_000;

type AllowedRpcMethod = "eth_call" | "eth_getTransactionReceipt";

function getPrivateRpcUrl() {
  const rpcUrl = process.env.BASE_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("BASE_RPC_URL is not configured");

  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error("BASE_RPC_URL is invalid");
  }

  const localHttp =
    process.env.NODE_ENV !== "production" &&
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);

  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("BASE_RPC_URL must use HTTPS");
  }

  return rpcUrl;
}

export async function privateBaseRpcRequest<T>(
  method: AllowedRpcMethod,
  params: readonly unknown[]
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const response = await fetch(getPrivateRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) throw new Error("Private Base RPC request failed");

    const payload = (await response.json()) as {
      result?: T;
      error?: unknown;
    };

    if (payload.error || !("result" in payload)) {
      throw new Error("Private Base RPC request failed");
    }

    return payload.result as T;
  } catch {
    // Never propagate fetch/provider errors because they can include the
    // private upstream URL. The API route returns a generic client message.
    throw new Error("Private Base RPC request failed");
  } finally {
    clearTimeout(timeout);
  }
}
