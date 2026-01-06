import "server-only";

type Mode = "upstash" | "vercel_kv" | "memory";

declare global {
  // eslint-disable-next-line no-var
  var __dwStorageMem: Map<string, string> | undefined;
}

const mem = globalThis.__dwStorageMem || (globalThis.__dwStorageMem = new Map());

function hasUpstashEnv() {
  return Boolean((process.env.UPSTASH_REDIS_REST_URL || "").trim() && (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim());
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
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !token) throw new Error("Missing UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN");
  if (!/^https:\/\//i.test(url)) {
    throw new Error("UPSTASH_REDIS_REST_URL must start with https:// (REST URL, not rediss://)");
  }
  upstashClient = new Redis({ url, token });
  return upstashClient;
}

export function storageDebugInfo() {
  const mode = storageMode();
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
  let host: string | null = null;
  try {
    host = url ? new URL(url).host : null;
  } catch {
    host = null;
  }
  return {
    mode,
    hasUpstash: hasUpstashEnv(),
    hasVercelKv: hasVercelKvEnv(),
    upstashHost: host,
  };
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
    // NOTE: @upstash/redis does **automatic deserialization** by default.
    // That means if we stored JSON (object/array/number/bool), redis.get(key)
    // can return a non-string value (e.g. an object), even if we originally
    // stored a JSON string.
    const raw = (await redis.get(key)) as any;
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") {
      const parsed = safeJsonParse(raw);
      return (parsed ?? (raw as any)) as T | null;
    }
    // object | number | boolean
    return raw as T;
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
    // Store as native value; the client serializes for us.
    await redis.set(key, value);
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
