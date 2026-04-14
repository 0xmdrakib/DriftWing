import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/server/redis";
import { syncLeaderboardFromChain } from "@/lib/server/syncLeaderboard";
import { rolloverIfNeeded, currentWeekId } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

/**
 * Cron endpoint: scans recent blockchain blocks for ScoreSubmitted events
 * and ingests them into the weekly leaderboard.
 *
 * Auth: if CRON_SECRET is set, requires Authorization: Bearer <secret>.
 * QStash / Vercel Cron both send this automatically.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) return unauthorized();

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      {
        ok: false,
        error: "Upstash Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 500 }
    );
  }

  // Sync blockchain events into leaderboard
  const result = await syncLeaderboardFromChain(redis, { maxBlocks: 1200n });

  // Rollover completed weeks (cron-less snapshot)
  await rolloverIfNeeded(currentWeekId(Date.now()));

  return NextResponse.json({
    ok: true,
    ...result,
  });
}

// Allow POST too (QStash sends POST by default)
export async function POST(req: NextRequest) {
  return GET(req);
}
