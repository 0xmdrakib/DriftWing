import "server-only";

import type { Redis } from "@upstash/redis";
import { publicClient, scoreSubmittedEvent } from "./chainClient";
import { getRedis } from "./redis";
import { upsertWeeklyBest, weekIdFromTs } from "@/lib/leaderboard";

// How many blocks to query per getLogs call (keeps RPC happy).
const CHUNK = 2000n;

// Redis keys for tracking sync state
const KEYS = {
  lastBlock: "dw:lb:sync:lastBlock",
  lastAutoSyncAt: "dw:lb:sync:lastAutoSyncAt",
};

export type SyncResult = {
  ok: boolean;
  error?: string;
  contract: string;
  fromBlock: string;
  toBlock: string;
  logsProcessed: number;
  usersTouched: number;
};

/**
 * Scans the blockchain for ScoreSubmitted events and ingests them
 * into the weekly leaderboard. Tracks the last processed block
 * in Redis to avoid re-processing.
 */
export async function syncLeaderboardFromChain(
  redis: Redis,
  opts?: { maxBlocks?: bigint }
): Promise<SyncResult> {
  const contract = process.env.NEXT_PUBLIC_SCOREBOARD_ADDRESS;
  if (!contract) {
    return {
      ok: false,
      error: "Missing NEXT_PUBLIC_SCOREBOARD_ADDRESS",
      contract: "",
      fromBlock: "0",
      toBlock: "0",
      logsProcessed: 0,
      usersTouched: 0,
    };
  }

  const latest = await publicClient.getBlockNumber();

  const last = await redis.get<number | string>(KEYS.lastBlock);

  let fromBlock: bigint;

  if (last === null || last === undefined) {
    // First run: only scan the last 1200 blocks to avoid RPC rate limits.
    const MAX_LOOKBACK = 1200n;
    fromBlock = latest > MAX_LOOKBACK ? latest - MAX_LOOKBACK : 0n;
  } else {
    fromBlock = BigInt(last) + 1n;
  }

  let toBlock = latest;

  if (opts?.maxBlocks && opts.maxBlocks > 0n) {
    const maxTo = fromBlock + opts.maxBlocks - 1n;
    if (maxTo < toBlock) toBlock = maxTo;
  }

  if (fromBlock > toBlock) {
    return {
      ok: true,
      contract,
      fromBlock: String(fromBlock),
      toBlock: String(toBlock),
      logsProcessed: 0,
      usersTouched: 0,
    };
  }

  let logsProcessed = 0;
  const touched = new Set<string>();

  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n;

    const logs = await publicClient.getLogs({
      address: contract as `0x${string}`,
      event: scoreSubmittedEvent,
      fromBlock: start,
      toBlock: end,
    });

    if (logs.length) {
      for (const log of logs as any[]) {
        const player = String(log.args.player).toLowerCase() as `0x${string}`;
        const score = Number(log.args.score);
        const tsSec = Number(log.args.timestamp);
        const tsMs = tsSec * 1000;

        // Get the tx hash from the log
        const txHash = (log.transactionHash || "0x") as `0x${string}`;

        // Upsert into the correct week based on the onchain timestamp
        await upsertWeeklyBest({
          tsMs,
          address: player,
          score,
          txHash,
        });

        touched.add(player);
      }
      logsProcessed += logs.length;
    }

    await redis.set(KEYS.lastBlock, String(end));
  }

  return {
    ok: true,
    contract,
    fromBlock: String(fromBlock),
    toBlock: String(toBlock),
    logsProcessed,
    usersTouched: touched.size,
  };
}

/**
 * Run auto-sync if 3 minutes have passed since the last run.
 * Designed to be called from the GET handler (piggyback on user traffic).
 */
export async function autoSyncIfDue(): Promise<SyncResult | null> {
  const redis = getRedis();
  if (!redis) return null;

  const now = Date.now();
  const lastSync = Number((await redis.get<number | string>(KEYS.lastAutoSyncAt)) ?? 0);

  if (lastSync && now - lastSync < 3 * 60_000) {
    return null; // Not due yet
  }

  await redis.set(KEYS.lastAutoSyncAt, String(now));

  try {
    return await syncLeaderboardFromChain(redis, { maxBlocks: 1200n });
  } catch (err) {
    console.error("[autoSync] Error scanning blockchain:", err);
    return null; // Non-fatal
  }
}
