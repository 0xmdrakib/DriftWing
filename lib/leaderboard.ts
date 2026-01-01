type Addr = `0x${string}`;

export type LeaderboardEntry = {
  address: Addr;
  score: number;
  updatedAt: number; // ms
  txHash: `0x${string}`;
};

type WeekStore = {
  weekId: number;
  updatedAt: number;
  entries: Record<string, LeaderboardEntry>; // keyed by lowercase address
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function weekStartMs(tsMs: number) {
  const d = new Date(tsMs);
  // Monday 00:00 UTC as the boundary.
  const day = (d.getUTCDay() + 6) % 7; // Monday=0 ... Sunday=6
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) - day * 24 * 60 * 60 * 1000;
  return start;
}

export function weekIdFromTs(tsMs: number) {
  return Math.floor(weekStartMs(tsMs) / WEEK_MS);
}

export function weekWindowFromId(weekId: number) {
  const start = weekId * WEEK_MS;
  return { startMs: start, endMs: start + WEEK_MS };
}

function kvEnabled() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvClient() {
  // Imported dynamically so local dev without KV env still works.
  const mod = await import("@vercel/kv");
  return mod.kv;
}

declare global {
  // eslint-disable-next-line no-var
  var __dwLeaderboardMem: Map<string, WeekStore> | undefined;
}
const mem = globalThis.__dwLeaderboardMem || (globalThis.__dwLeaderboardMem = new Map());

function keyForWeek(weekId: number) {
  return `dw:leaderboard:week:${weekId}`;
}

export async function loadWeekStore(weekId: number): Promise<WeekStore> {
  const key = keyForWeek(weekId);

  if (kvEnabled()) {
    const kv = await kvClient();
    const existing = (await kv.get<WeekStore>(key)) ?? null;
    if (existing && typeof existing === "object" && existing.weekId === weekId) return existing;
  } else {
    const existing = mem.get(key);
    if (existing) return existing;
  }

  const fresh: WeekStore = { weekId, updatedAt: Date.now(), entries: {} };
  return fresh;
}

export async function saveWeekStore(store: WeekStore) {
  const key = keyForWeek(store.weekId);
  store.updatedAt = Date.now();

  if (kvEnabled()) {
    const kv = await kvClient();
    await kv.set(key, store);
  } else {
    mem.set(key, store);
  }
}

export function topEntries(store: WeekStore, limit = 100) {
  const arr = Object.values(store.entries);
  arr.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // tie-breaker: earlier update wins (stable-ish)
    return a.updatedAt - b.updatedAt;
  });
  return arr.slice(0, limit);
}

export function rankOf(store: WeekStore, address: string) {
  const addr = address.toLowerCase();
  const arr = topEntries(store, 5000); // safe upper bound for early stage
  const idx = arr.findIndex((e) => e.address.toLowerCase() === addr);
  return idx >= 0 ? idx + 1 : null;
}

/**
 * Upsert a player's weekly best score.
 * - If score is higher than their existing weekly best, it replaces it.
 * - If score is equal/lower, it keeps the best (duplicates allowed but don't change rank).
 */
export async function upsertWeeklyBest(params: {
  tsMs: number;
  address: Addr;
  score: number;
  txHash: `0x${string}`;
}) {
  const weekId = weekIdFromTs(params.tsMs);
  const store = await loadWeekStore(weekId);

  const k = params.address.toLowerCase();
  const existing = store.entries[k];

  const next: LeaderboardEntry = {
    address: params.address,
    score: params.score,
    txHash: params.txHash,
    updatedAt: Date.now(),
  };

  if (!existing || params.score > existing.score) {
    store.entries[k] = next;
  } else {
    // keep the existing best
  }

  // Trim to top 100 for storage size (optional). We'll keep more in early stage by not trimming entries map,
  // but the UI always displays top 100.
  await saveWeekStore(store);

  return { weekId, store };
}
