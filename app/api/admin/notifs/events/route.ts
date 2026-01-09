import { NextResponse } from "next/server";
import { getRedis } from "@/lib/server/redis";
import { NOTIF_KEYS } from "@/lib/server/notificationsStore";

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

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));

  const raw: string[] = (await redis.lrange(NOTIF_KEYS.events, 0, limit - 1)) ?? [];
  const events = raw.map((s) => {
    try {
      return JSON.parse(s);
    } catch {
      return { raw: s };
    }
  });

  return NextResponse.json({ ok: true, events });
}
