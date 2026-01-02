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

const DEFAULT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Week 0 anchor. By default we start counting from 2026-01-01 00:00:00 UTC,
 * so weeks are: 0, 1, 2... in a simple, predictable sequence.
 *
 * You can override in env:
 *   LEADERBOARD_GENESIS_ISO="2026-01-01T00:00:00Z"
 * For fast local testing you can also shorten the week:
 *   LEADERBOARD_WEEK_SECONDS=60   (or LEADERBOARD_WEEK_MS=60000)
 */
function getGenesisMs() {
  const iso = process.env.LEADERBOARD_GENESIS_ISO || "2026-01-01T00:00:00.000Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.UTC(2026, 0, 1, 0, 0, 0, 0);
}

function getWeekMs() {
  const msRaw = process.env.LEADERBOARD_WEEK_MS;
  const secRaw = process.env.LEADERBOARD_WEEK_SECONDS;
  const ms = msRaw ? Number(msRaw) : secRaw ? Number(secRaw) * 1000 : DEFAULT_WEEK_MS;
  return Number.isFinite(ms) && ms >= 10_000 ? ms : DEFAULT_WEEK_MS; // minimum 10s safety
}

export function weekStartMs(tsMs: number) {
  const weekId = weekIdFromTs(tsMs);
  return weekWindowFromId(weekId).startMs;
}

export function weekIdFromTs(tsMs: number) {
  const genesis = getGenesisMs();
  const weekMs = getWeekMs();
  return Math.max(0, Math.floor((tsMs - genesis) / weekMs));
}

export function currentWeekId(tsMs = Date.now()) {
  return weekIdFromTs(tsMs);
}

export function weekWindowFromId(weekId: number) {
  const genesis = getGenesisMs();
  const weekMs = getWeekMs();
  const start = genesis + weekId * weekMs;
  return { startMs: start, endMs: start + weekMs, weekMs, genesisMs: genesis };
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

export async function deleteWeekStore(weekId: number) {
  const key = keyForWeek(weekId);

  if (kvEnabled()) {
    const kv = await kvClient();
    await kv.del(key);
  } else {
    mem.delete(key);
  }
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
