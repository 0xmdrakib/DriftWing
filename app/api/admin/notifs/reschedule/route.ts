import { NextResponse } from "next/server";
import { getRedis } from "@/lib/server/redis";
import { clampCadenceHours, loadNotification, NOTIF_KEYS, parseMemberId, pushEvent } from "@/lib/server/notificationsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

/**
 * Reschedule all registered tokens to a new cadence.
 * Example:
 *   POST /api/admin/notifs/reschedule?cadenceHours=1
 */
export async function POST(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const redis = getRedis();
  if (!redis) return NextResponse.json({ ok: false, error: "Redis not configured" }, { status: 500 });

  const url = new URL(req.url);
  const cadenceHours = clampCadenceHours(Number(url.searchParams.get("cadenceHours") ?? process.env.NOTIF_CADENCE_HOURS ?? "6"));
  const now = Math.floor(Date.now() / 1000);

  // scan dueZ (bounded)
  const members: string[] = (await redis.zrange(NOTIF_KEYS.dueZ, 0, 1999)) ?? [];

  let updated = 0;
  let missing = 0;

  for (const memberId of members) {
    const rec = await loadNotification(redis, memberId);
    if (!rec) {
      missing++;
      continue;
    }

    rec.cadenceHours = cadenceHours;
    rec.nextSendAt = now + cadenceHours * 60 * 60;
    rec.updatedAt = now;

    await redis.set(NOTIF_KEYS.user(rec.fid, rec.appFid), JSON.stringify(rec));
    await redis.zadd(NOTIF_KEYS.dueZ, { score: rec.nextSendAt, member: memberId });
    updated++;
  }

  await pushEvent(redis, { type: "admin_reschedule", cadenceHours, updated, missing });

  return NextResponse.json({ ok: true, cadenceHours, updated, missing });
}
