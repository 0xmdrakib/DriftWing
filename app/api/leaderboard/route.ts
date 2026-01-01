import { NextResponse } from "next/server";
import { createPublicClient, decodeEventLog, http } from "viem";
import { base } from "viem/chains";
import { scoreboardAbi } from "@/lib/scoreboardAbi";
import {
  loadWeekStore,
  topEntries,
  upsertWeeklyBest,
  weekIdFromTs,
  weekStartMs,
  weekWindowFromId,
  rankOf,
} from "@/lib/leaderboard";

export const runtime = "nodejs";

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
const SCOREBOARD_ADDRESS = process.env.NEXT_PUBLIC_SCOREBOARD_ADDRESS as `0x${string}` | undefined;

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

function nowMs() {
  return Date.now();
}

function currentWeekId() {
  return weekIdFromTs(nowMs());
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week");
  const weekId = weekParam ? Number(weekParam) : currentWeekId();
  if (!Number.isFinite(weekId)) return json({ error: "Invalid week" }, 400);

  const store = await loadWeekStore(weekId);
  const { startMs, endMs } = weekWindowFromId(weekId);

  const top = topEntries(store, 100).map((e) => ({
    address: e.address,
    score: e.score,
  }));

  const account = url.searchParams.get("account");
  const myRank = account ? rankOf(store, account) : null;

  return json({
    weekId,
    weekStartMs: startMs,
    weekEndMs: endMs,
    nowMs: nowMs(),
    secondsRemaining: Math.max(0, Math.floor((endMs - nowMs()) / 1000)),
    top,
    myRank,
    kvEnabled: Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  });
}

export async function POST(req: Request) {
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
  } catch (e: any) {
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

  // Store/update the weekly best for this player.
  const { weekId, store } = await upsertWeeklyBest({
    tsMs,
    address: player,
    score,
    txHash,
  });

  const { startMs, endMs } = weekWindowFromId(weekId);

  return json({
    status: "ok",
    weekId,
    weekStartMs: startMs,
    weekEndMs: endMs,
    top: topEntries(store, 100).map((e) => ({ address: e.address, score: e.score })),
    myRank: rankOf(store, player),
    saved: { address: player, score, tsMs, txHash },
  });
}
