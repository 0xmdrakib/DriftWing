import { NextResponse } from "next/server";
import { createPublicClient, decodeEventLog, http } from "viem";
import { base } from "viem/chains";
import { scoreboardAbi } from "@/lib/scoreboardAbi";
import { storageDebugInfo } from "@/lib/storage";
import {
  currentWeekId,
  getWeekLeaderboardView,
  isStorageEnabled,
  rankOf,
  rolloverIfNeeded,
  topEntries,
  upsertWeeklyBest,
  weekWindowFromId,
} from "@/lib/leaderboard";

export const runtime = "nodejs";

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
const SCOREBOARD_ADDRESS = process.env.NEXT_PUBLIC_SCOREBOARD_ADDRESS as `0x${string}` | undefined;

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

function errorJson(where: string, err: unknown) {
  console.error(`[leaderboard:${where}]`, err);
  const e: any = err;
  const msg = err instanceof Error ? err.message : String(err);
  const cause = e?.cause;
  const details = cause
    ? {
        name: cause?.name,
        message: cause?.message ?? String(cause),
        code: cause?.code,
        errno: cause?.errno,
        syscall: cause?.syscall,
      }
    : null;
  return json(
    {
      error: "Internal error",
      where,
      message: msg.slice(0, 200),
      storage: storageDebugInfo(),
      cause: details,
    },
    500
  );
}

function rankInTop(top: Array<{ address: string }>, account: string) {
  const a = account.toLowerCase();
  const idx = top.findIndex((e) => e.address.toLowerCase() === a);
  return idx >= 0 ? idx + 1 : null;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const nowMs = Date.now();
    const nowWeek = currentWeekId(nowMs);

    const weekParam = url.searchParams.get("week");
    const requestedWeek = weekParam ? Number(weekParam) : nowWeek;
    if (!Number.isFinite(requestedWeek) || requestedWeek < 0) return json({ error: "Invalid week" }, 400);

    const account = url.searchParams.get("account");

    const view = await getWeekLeaderboardView({ weekId: requestedWeek, nowWeekId: nowWeek });

    if (view.kind === "snapshot") {
      return json({
        kind: view.kind,
        weekId: view.weekId,
        currentWeekId: nowWeek,
        weekStartMs: view.weekStartMs,
        weekEndMs: view.weekEndMs,
        nowMs,
        secondsRemaining: 0,
        top: view.top.map((e) => ({ address: e.address, score: e.score })),
        myRank: account ? rankInTop(view.top, account) : null,
        totalPlayers: view.totalPlayers,
        kvEnabled: isStorageEnabled(),
      });
    }

    // live
    const { startMs, endMs } = weekWindowFromId(view.weekId);
    const top = topEntries(view.store, 100).map((e) => ({ address: e.address, score: e.score }));
    const myRank = account ? rankOf(view.store, account) : null;

    return json({
      kind: view.kind,
      weekId: view.weekId,
      currentWeekId: nowWeek,
      weekStartMs: startMs,
      weekEndMs: endMs,
      nowMs,
      secondsRemaining: Math.max(0, Math.floor((endMs - nowMs) / 1000)),
      top,
      myRank,
      totalPlayers: Object.keys(view.store.entries).length,
      kvEnabled: isStorageEnabled(),
    });
  } catch (err) {
    return errorJson("GET", err);
  }
}

export async function POST(req: Request) {
  try {
    if (!SCOREBOARD_ADDRESS) return json({ error: "Scoreboard not configured" }, 400);

    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const txHash = (body?.txHash || "").toString() as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return json({ error: "Invalid txHash" }, 400);

    const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

    let receipt: any;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch {
      // Pending or not found yet.
      return json({ status: "pending", message: "Transaction not found yet. Try again in a few seconds." }, 202);
    }

    if (!receipt || receipt.status !== "success") {
      return json({ error: "Transaction failed" }, 400);
    }

    // Find ScoreSubmitted event emitted by the scoreboard.
    let player: `0x${string}` | null = null;
    let score: number | null = null;
    let tsSec: number | null = null;

    for (const log of receipt.logs || []) {
      if (!log?.address) continue;
      if (log.address.toLowerCase() !== SCOREBOARD_ADDRESS.toLowerCase()) continue;

      try {
        const decoded = decodeEventLog({
          abi: scoreboardAbi,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName === "ScoreSubmitted") {
          const args: any = decoded.args;
          player = args.player as `0x${string}`;
          score = Number(args.score);
          tsSec = Number(args.timestamp);
          break;
        }
      } catch {
        // ignore non-matching logs
      }
    }

    if (!player || score == null || tsSec == null) {
      return json({ error: "No ScoreSubmitted event found in tx" }, 400);
    }

    const tsMs = tsSec * 1000;

    // 1) Ingest the score into the week implied by the onchain timestamp.
    const { weekId, store } = await upsertWeeklyBest({
      tsMs,
      address: player,
      score,
      txHash,
    });

    // 2) Then rollover/snapshot based on *server now* (cron-less), AFTER ingestion.
    await rolloverIfNeeded(currentWeekId(Date.now()));

    const { startMs, endMs } = weekWindowFromId(weekId);

    return json({
      status: "ok",
      weekId,
      currentWeekId: currentWeekId(Date.now()),
      weekStartMs: startMs,
      weekEndMs: endMs,
      top: topEntries(store, 100).map((e) => ({ address: e.address, score: e.score })),
      myRank: rankOf(store, player),
      saved: { address: player, score, tsMs, txHash },
    });
  } catch (err) {
    return errorJson("POST", err);
  }
}
