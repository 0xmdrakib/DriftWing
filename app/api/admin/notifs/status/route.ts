import { NextResponse } from "next/server";
import { getRedis } from "@/lib/server/redis";
import { NOTIF_KEYS, parseMemberId } from "@/lib/server/notificationsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const redis = getRedis();
  if (!redis) return NextResponse.json({ ok: false, error: "Redis not configured" }, { status: 500 });

  const now = Math.floor(Date.now() / 1000);

  // Count registered users: approximate by scanning dueZ (works because we keep it in sync)
  const registered = (await redis.zcard(NOTIF_KEYS.dueZ)) ?? 0;

  // Count due now
  const dueMembers: string[] =
    (await redis.zrange(NOTIF_KEYS.dueZ, 0, now, { byScore: true, offset: 0, count: 200 })) ?? [];
  const due = dueMembers.length;

  // Soonest next send
  const soonestMembers: string[] = (await redis.zrange(NOTIF_KEYS.dueZ, 0, 0)) ?? [];
  let soonest: any = null;

  if (soonestMembers[0]) {
    const m = soonestMembers[0];
    const parsed = parseMemberId(m);
    const score = await redis.zscore(NOTIF_KEYS.dueZ, m);
    if (parsed && score) {
      soonest = { member: m, nextSendAt: Number(score), inSeconds: Number(score) - now };
    }
  }

  return NextResponse.json({ ok: true, now, registered, due, soonest });
}
