import { NextResponse } from "next/server";
import { getRedis } from "@/lib/server/redis";
import {
  loadNotification,
  NOTIF_KEYS,
  pushEvent,
  removeNotification,
  type NotifRecord,
} from "@/lib/server/notificationsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://driftwing.vercel.app/");

type SendResult =
  | { ok: true }
  | { ok: false; status?: number; error: string; retryable?: boolean };

async function sendNotification(rec: NotifRecord): Promise<SendResult> {
  // Customize these defaults for your mini app
  const title = "DriftWing 🪽";
  const body = "Quick check-in: come back to DriftWing.";
  const targetUrl = APP_URL;
  // Stable-ish id per send window. Used for Farcaster idempotency.
  const notificationId = `dw-${rec.cadenceHours}h-${Math.floor(Date.now() / 1000 / (rec.cadenceHours * 60 * 60))}`;

  try {
    const res = await fetch(rec.details.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        notificationId,
        title,
        body,
        targetUrl,
        tokens: [rec.details.token],
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // 4xx usually means token revoked/expired
      const retryable = res.status >= 500;
      return { ok: false, status: res.status, error: txt || res.statusText, retryable };
    }

    // The notifications endpoint returns 200 even when some tokens are invalid or rate limited.
    // Handle that for the single-token case.
    try {
      const data = (await res.json()) as any;
      const token = rec.details.token;
      if (Array.isArray(data?.invalidTokens) && data.invalidTokens.includes(token)) {
        return { ok: false, status: 400, error: "invalid token", retryable: false };
      }
      if (Array.isArray(data?.rateLimitedTokens) && data.rateLimitedTokens.includes(token)) {
        return { ok: false, status: 429, error: "rate limited", retryable: true };
      }
    } catch {
      // Some hosts may not return JSON; treat as success.
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "network error", retryable: true };
  }
}

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

  // Grab a small batch of due members
  const members: string[] =
    (await redis.zrange(NOTIF_KEYS.dueZ, 0, now, { byScore: true, offset: 0, count: 25 })) ?? [];

  let due = 0;
  let sent = 0;
  let invalid = 0;
  let rateLimited = 0;

  for (const memberId of members) {
    due++;

    const rec = await loadNotification(redis, memberId);
    if (!rec) {
      await pushEvent(redis, { type: "cron_missing_record", memberId });
      continue;
    }

    // Not actually due (race / schedule jitter)
    if (rec.nextSendAt > now) continue;

    const result = await sendNotification(rec);

    if (result.ok) {
      sent++;

      // schedule next run
      const nextSendAt = now + rec.cadenceHours * 60 * 60;
      rec.nextSendAt = nextSendAt;
      rec.updatedAt = now;

      await redis.set(NOTIF_KEYS.user(rec.fid, rec.appFid), JSON.stringify(rec));
      await redis.zadd(NOTIF_KEYS.dueZ, { score: rec.nextSendAt, member: memberId });

      await pushEvent(redis, { type: "cron_sent", fid: rec.fid, appFid: rec.appFid, nextSendAt });
    } else {
      if (result.status === 429) {
        rateLimited++;
        await pushEvent(redis, {
          type: "cron_rate_limited",
          fid: rec.fid,
          appFid: rec.appFid,
          status: result.status,
          error: result.error,
        });
        // keep it in the queue; we'll try later
        continue;
      }

      // If token is invalid / revoked, drop it.
      if (result.status && result.status >= 400 && result.status < 500 && result.status !== 429) {
        invalid++;
        await pushEvent(redis, {
          type: "cron_invalid_token",
          fid: rec.fid,
          appFid: rec.appFid,
          status: result.status,
          error: result.error,
        });
        await removeNotification(redis, rec.fid, rec.appFid);
        continue;
      }

      // 5xx or network -> retry later (bump by 10 min)
      await pushEvent(redis, {
        type: "cron_retry",
        fid: rec.fid,
        appFid: rec.appFid,
        status: result.status,
        error: result.error,
      });

      const bump = now + 10 * 60;
      await redis.zadd(NOTIF_KEYS.dueZ, { score: bump, member: memberId });
    }
  }

  return NextResponse.json({ ok: true, due, sent, invalid, rateLimited });
}
