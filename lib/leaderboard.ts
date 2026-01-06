// DriftWing weekly leaderboard storage
// - No cron required
// - Rollover happens on demand (first request after a week ends)
// - DB stays tidy: live week stores + immutable snapshots

type Addr = `0x${string}`;

export type LeaderboardEntry = {
  address: Addr;
  score: number;
  updatedAt: number; // ms
  txHash: `0x${string}`;
};

export type WeekStore = {
  weekId: number;
  updatedAt: number;
  entries: Record<string, LeaderboardEntry>; // keyed by lowercase address
};

export type WeekSnapshot = {
  weekId: number;
  weekStartMs: number;
  weekEndMs: number;
  createdAtMs: number;
  totalPlayers: number;
  top: LeaderboardEntry[]; // top 100 only (UI shows top 100)
};

const DEFAULT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = "dw:lb";

const KEY = {
  weekStore: (weekId: number) => `${PREFIX}:week:${weekId}`,
  snapshot: (weekId: number) => `${PREFIX}:snapshot:${weekId}`,
  snapshotsIndex: `${PREFIX}:snapshots`,
  lastSnapWeekId: `${PREFIX}:lastSnapWeekId`,
};

/**
 * Week 0 anchor (UTC). Override in env:
 *   LEADERBOARD_GENESIS_ISO="2026-01-01T00:00:00Z"
 */
function getGenesisMs() {
  const iso = process.env.LEADERBOARD_GENESIS_ISO || "2026-01-01T00:00:00.000Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.UTC(2026, 0, 1, 0, 0, 0, 0);
}

/**
 * Override for testing:
 *   LEADERBOARD_WEEK_SECONDS=60
 *   LEADERBOARD_WEEK_MS=60000
 */
function getWeekMs() {
  const msRaw = process.env.LEADERBOARD_WEEK_MS;
  const secRaw = process.env.LEADERBOARD_WEEK_SECONDS;
  const ms = msRaw ? Number(msRaw) : secRaw ? Number(secRaw) * 1000 : DEFAULT_WEEK_MS;
  return Number.isFinite(ms) && ms >= 10_000 ? ms : DEFAULT_WEEK_MS; // minimum 10s safety
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
  const startMs = genesis + weekId * weekMs;
  return { startMs, endMs: startMs + weekMs, weekMs, genesisMs: genesis };
}

function storageEnabled() {
  // Vercel KV vars OR plain Upstash vars (personal Upstash)
  const hasKv = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  const hasUpstash = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  return hasKv || hasUpstash;
}

async function kvClient(): Promise<any> {
  // Dynamic import so local dev works without env.
  const mod: any = await import("@vercel/kv");

  // 1) If Vercel KV env is present, just use it.
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) return mod.kv;

  // 2) If personal Upstash env is present, create a client pointing to it.
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token && typeof mod.createClient === "function") {
    return mod.createClient({ url, token });
  }

  // 3) Fall back to default export (may still work if user used KV vars).
  return mod.kv;
}

declare global {
  // eslint-disable-next-line no-var
  var __dwLeaderboardMem: Map<string, any> | undefined;
}
const mem = globalThis.__dwLeaderboardMem || (globalThis.__dwLeaderboardMem = new Map());

async function getJson<T>(key: string): Promise<T | null> {
  if (storageEnabled()) {
    const kv = await kvClient();
    const v = await kv.get(key);
    return (v ?? null) as T | null;
  }
  return (mem.get(key) ?? null) as T | null;
}

async function setJson(key: string, value: any) {
  if (storageEnabled()) {
    const kv = await kvClient();
    await kv.set(key, value);
  } else {
    mem.set(key, value);
  }
}

async function delKey(key: string) {
  if (storageEnabled()) {
    const kv = await kvClient();
    await kv.del(key);
  } else {
    mem.delete(key);
  }
}

function isWeekStore(v: any, weekId: number): v is WeekStore {
  return Boolean(v && typeof v === "object" && v.weekId === weekId && v.entries && typeof v.entries === "object");
}

function isSnapshot(v: any, weekId: number): v is WeekSnapshot {
  return Boolean(v && typeof v === "object" && v.weekId === weekId && Array.isArray(v.top));
}

export async function loadWeekStore(weekId: number): Promise<WeekStore> {
  const key = KEY.weekStore(weekId);
  const existing = await getJson<WeekStore>(key);
  if (existing && isWeekStore(existing, weekId)) return existing;
  return { weekId, updatedAt: Date.now(), entries: {} };
}

export async function saveWeekStore(store: WeekStore) {
  store.updatedAt = Date.now();
  await setJson(KEY.weekStore(store.weekId), store);
}

export async function deleteWeekStore(weekId: number) {
  await delKey(KEY.weekStore(weekId));
}

export function topEntries(store: WeekStore, limit = 100) {
  const arr = Object.values(store.entries);
  arr.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.updatedAt - b.updatedAt;
  });
  return arr.slice(0, limit);
}

export function rankOf(store: WeekStore, address: string) {
  const addr = address.toLowerCase();
  const arr = Object.values(store.entries);
  arr.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.updatedAt - b.updatedAt;
  });
  const idx = arr.findIndex((e) => e.address.toLowerCase() === addr);
  return idx >= 0 ? idx + 1 : null;
}

async function getLastSnapWeekId(): Promise<number> {
  const v = await getJson<number>(KEY.lastSnapWeekId);
  return typeof v === "number" && Number.isFinite(v) ? v : -1;
}

async function setLastSnapWeekId(v: number) {
  await setJson(KEY.lastSnapWeekId, v);
}

async function readSnapshotsIndex(): Promise<number[]> {
  const v = await getJson<number[] | string>(KEY.snapshotsIndex);
  if (Array.isArray(v)) return v.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (typeof v === "string") {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.filter((n) => typeof n === "number" && Number.isFinite(n));
    } catch {
      // ignore
    }
  }
  return [];
}

async function writeSnapshotsIndex(arr: number[]) {
  // keep it sorted + unique
  const uniq = Array.from(new Set(arr)).sort((a, b) => a - b);
  await setJson(KEY.snapshotsIndex, uniq);
}

async function ensureWeekSnapshot(weekId: number) {
  // If snapshot already exists, don't recreate.
  const existing = await getJson<WeekSnapshot>(KEY.snapshot(weekId));
  if (existing && isSnapshot(existing, weekId)) return existing;

  const store = await loadWeekStore(weekId);
  const { startMs, endMs } = weekWindowFromId(weekId);

  const snap: WeekSnapshot = {
    weekId,
    weekStartMs: startMs,
    weekEndMs: endMs,
    createdAtMs: Date.now(),
    totalPlayers: Object.keys(store.entries).length,
    top: topEntries(store, 100),
  };

  await setJson(KEY.snapshot(weekId), snap);

  const idx = await readSnapshotsIndex();
  if (!idx.includes(weekId)) {
    idx.push(weekId);
    await writeSnapshotsIndex(idx);
  }

  // Once snapshotted, delete the live week key to keep DB clean.
  await deleteWeekStore(weekId);
  return snap;
}

/**
 * Snapshots all fully-ended weeks up to nowWeekId-1.
 * This is what makes the system \"cron-less\".
 */
export async function rolloverIfNeeded(nowWeekId = currentWeekId()) {
  const target = nowWeekId - 1;
  if (target < 0) return;

  let last = await getLastSnapWeekId();
  if (last >= target) return;

  for (let w = last + 1; w <= target; w++) {
    await ensureWeekSnapshot(w);
    last = w;
    await setLastSnapWeekId(last);
  }
}

export async function readSnapshot(weekId: number): Promise<WeekSnapshot | null> {
  const v = await getJson<WeekSnapshot>(KEY.snapshot(weekId));
  return v && isSnapshot(v, weekId) ? v : null;
}

/**
 * Returns leaderboard data for a week, preferring snapshots for past weeks.
 */
export async function getWeekLeaderboardView(params: {
  weekId: number;
  nowWeekId?: number;
}) {
  const nowWeek = typeof params.nowWeekId === "number" ? params.nowWeekId : currentWeekId();

  // Always attempt rollover first so \"last week\" becomes a snapshot right after reset.
  await rolloverIfNeeded(nowWeek);

  if (params.weekId < nowWeek) {
    const snap = await readSnapshot(params.weekId);
    if (snap) {
      return {
        kind: "snapshot" as const,
        weekId: snap.weekId,
        weekStartMs: snap.weekStartMs,
        weekEndMs: snap.weekEndMs,
        top: snap.top,
        totalPlayers: snap.totalPlayers,
      };
    }
    // Past week but no snapshot (should be rare). Return empty snapshot-like response.
    const { startMs, endMs } = weekWindowFromId(params.weekId);
    return {
      kind: "snapshot" as const,
      weekId: params.weekId,
      weekStartMs: startMs,
      weekEndMs: endMs,
      top: [] as LeaderboardEntry[],
      totalPlayers: 0,
    };
  }

  const store = await loadWeekStore(params.weekId);
  const { startMs, endMs } = weekWindowFromId(params.weekId);
  return {
    kind: "live" as const,
    weekId: store.weekId,
    weekStartMs: startMs,
    weekEndMs: endMs,
    store,
  };
}

/**
 * Upsert a player's weekly best score.
 * - If score is higher than their existing weekly best, it replaces it.
 * - If score is equal/lower, it keeps the best.
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
    await saveWeekStore(store);
  } else {
    // keep existing best (no write)
  }

  return { weekId, store };
}

export function isStorageEnabled() {
  return storageEnabled();
}
