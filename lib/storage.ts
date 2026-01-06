import "server-only";

type Mode = "upstash" | "vercel_kv" | "memory";

declare global {
  // eslint-disable-next-line no-var
  var __dwStorageMem: Map<string, string> | undefined;
}

const mem = globalThis.__dwStorageMem || (globalThis.__dwStorageMem = new Map());

function hasUpstashEnv() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function hasVercelKvEnv() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export function storageMode(): Mode {
  if (hasUpstashEnv()) return "upstash";
  if (hasVercelKvEnv()) return "vercel_kv";
  return "memory";
}

let upstashClient: any | null = null;
async function getUpstashClient() {
  if (upstashClient) return upstashClient;
  const { Redis } = await import("@upstash/redis");
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  upstashClient = new Redis({ url, token });
  return upstashClient;
}

let vercelKvClient: any | null = null;
async function getVercelKvClient() {
  if (vercelKvClient) return vercelKvClient;
  const mod: any = await import("@vercel/kv");
  vercelKvClient = mod.kv;
  return vercelKvClient;
}

function safeJsonParse(s: string | null) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function getJson<T>(key: string): Promise<T | null> {
  const mode = storageMode();

  if (mode === "upstash") {
    const redis = await getUpstashClient();
    const raw = (await redis.get(key)) as any;
    if (typeof raw !== "string") return null;
    return (safeJsonParse(raw) ?? null) as T | null;
  }

  if (mode === "vercel_kv") {
    const kv = await getVercelKvClient();
    const v = await kv.get(key);
    if (typeof v === "string") {
      const parsed = safeJsonParse(v);
      return (parsed ?? (v as any)) as T | null;
    }
    return (v ?? null) as T | null;
  }

  const raw = mem.get(key) ?? null;
  return (safeJsonParse(raw) ?? null) as T | null;
}

export async function setJson(key: string, value: any) {
  const mode = storageMode();

  if (mode === "upstash") {
    const redis = await getUpstashClient();
    await redis.set(key, JSON.stringify(value));
    return;
  }

  if (mode === "vercel_kv") {
    const kv = await getVercelKvClient();
    await kv.set(key, value);
    return;
  }

  mem.set(key, JSON.stringify(value));
}

export async function delKey(key: string) {
  const mode = storageMode();

  if (mode === "upstash") {
    const redis = await getUpstashClient();
    await redis.del(key);
    return;
  }

  if (mode === "vercel_kv") {
    const kv = await getVercelKvClient();
    await kv.del(key);
    return;
  }

  mem.delete(key);
}
