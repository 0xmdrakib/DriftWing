import { NextResponse } from "next/server";
import { getRedis } from "@/lib/server/redis";
import {
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
  const title = "Drift Wing ✈️";
  const body = "Play DriftWing and beat leaderboard again.";
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
  // Allow auth via header (recommended) OR query param as a fallback for schedulers
  // that make header-forwarding fiddly.
  try {
    const url = new URL(req.url);
    const qp = url.searchParams.get("cron_secret");
    if (qp && qp === secret) return true;
  } catch {
    // ignore
  }

  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;

  // Some QStash setups forward headers under a prefixed name.
  const forwarded = req.headers.get("upstash-forward-authorization") || "";
  if (forwarded === `Bearer ${secret}`) return true;

  const x = req.headers.get("x-cron-secret") || "";
  return x === secret;
}

function safeJsonParse<T>(raw: unknown): T | null {
  if (!raw) return null;
  // Upstash Redis can return either a string (if we stored a string) OR a decoded object
  // (if older code stored an object). Accept both.
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object") return raw as T;
  return null;
}

function parseMemberId(memberId: string): { fid: number; appFid: number } | null {
  const [fidStr, appFidStr] = memberId.split(":");
  const fid = Number(fidStr);
  const appFid = Number(appFidStr);
  if (!Number.isFinite(fid) || !Number.isFinite(appFid)) return null;
  return { fid, appFid };
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const redis = getRedis();
  if (!redis) return NextResponse.json({ ok: false, error: "Redis not configured" }, { status: 500 });

  // Never let this endpoint crash (QStash will retry forever on 500).
  // Instead: log the error into Redis + return a 200 with {ok:false}.
  try {
    const now = Math.floor(Date.now() / 1000);

    // Grab a small batch of due members.
    // @upstash/redis v1.x paginates ZRANGE BYSCORE via `offset`/`count`.
    let members: string[] = [];
    try {
      members =
        ((await redis.zrange(NOTIF_KEYS.dueZ, 0, now, {
          byScore: true,
          offset: 0,
          count: 25,
        })) as string[]) ?? [];
    } catch (e: any) {
      // Fallback: try without LIMIT so the endpoint still works (just with a larger batch).
      await pushEvent(redis, {
        type: "cron_zrange_error",
        hint: e?.message ?? String(e),
      });

      members = ((await redis.zrange(NOTIF_KEYS.dueZ, 0, now, { byScore: true })) as string[]) ?? [];
    }

    let due = 0;
    let sent = 0;
    let invalid = 0;
    let rateLimited = 0;
    let errors = 0;

    for (const memberId of members) {
      due++;

      try {
        const parsed = parseMemberId(memberId);
        if (!parsed) {
          errors++;
          await pushEvent(redis, { type: "cron_bad_member", memberId });
          // best-effort cleanup
          await redis.zrem(NOTIF_KEYS.dueZ, memberId);
          continue;
        }

        const key = NOTIF_KEYS.user(parsed.fid, parsed.appFid);
        const raw = await redis.get(key);
        const rec0 = safeJsonParse<any>(raw);

        // Data migration / validation.
        // Over time you may have stored different shapes:
        // - full NotifRecord { details: {token,url,...}, cadenceHours, nextSendAt, ... }
        // - just NotificationDetails { token, url, appFid }
        // - webhook-ish { notificationDetails: { token, url } }
        // Convert anything usable into a proper NotifRecord so cron can send.
        let rec: NotifRecord | null = null;
        if (rec0 && typeof rec0 === "object") {
          const token =
            (rec0 as any).details?.token ?? (rec0 as any).token ?? (rec0 as any).notificationDetails?.token;
          const url = (rec0 as any).details?.url ?? (rec0 as any).url ?? (rec0 as any).notificationDetails?.url;

          if (typeof token === "string" && typeof url === "string") {
            const cadence = (rec0 as any).cadenceHours;
            const cadenceHours: 1 | 6 | 12 = cadence === 1 || cadence === 6 || cadence === 12 ? cadence : 6;
            const nextSendAtRaw = (rec0 as any).nextSendAt;
            const createdAtRaw = (rec0 as any).createdAt;
            const updatedAtRaw = (rec0 as any).updatedAt;

            rec = {
              fid: Number.isFinite((rec0 as any).fid) ? (rec0 as any).fid : parsed.fid,
              appFid: Number.isFinite((rec0 as any).appFid) ? (rec0 as any).appFid : parsed.appFid,
              details: {
                token,
                url,
                appFid: Number.isFinite((rec0 as any).details?.appFid)
                  ? (rec0 as any).details.appFid
                  : parsed.appFid,
              },
              cadenceHours,
              nextSendAt: Number.isFinite(nextSendAtRaw) ? nextSendAtRaw : now, // send ASAP if missing
              createdAt: Number.isFinite(createdAtRaw) ? createdAtRaw : now,
              updatedAt: Number.isFinite(updatedAtRaw) ? updatedAtRaw : now,
            };
          }
        }

        if (!rec) {
          errors++;
          await pushEvent(redis, { type: "cron_bad_record", memberId, key });
          // If the stored value is unusable, clean it up.
          await removeNotification(redis, parsed.fid, parsed.appFid);
          continue;
        }

        // Persist the normalized shape so future cron runs don't have to migrate again.
        await redis.set(NOTIF_KEYS.user(rec.fid, rec.appFid), JSON.stringify(rec));

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
          continue;
        }

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
      } catch (e: any) {
        errors++;
        await pushEvent(redis, {
          type: "cron_member_error",
          memberId,
          hint: e?.message ?? String(e),
        });
      }
    }

    return NextResponse.json({ ok: true, due, sent, invalid, rateLimited, errors });
  } catch (e: any) {
    try {
      await pushEvent(redis, { type: "cron_unhandled", hint: e?.message ?? String(e) });
    } catch {
      // last resort: swallow; returning 200 prevents QStash retry storms
    }
    // Return 200 to stop infinite retries; details are in dw:notif:events.
    return NextResponse.json({ ok: false, error: "cron_unhandled", hint: e?.message ?? String(e) }, { status: 200 });
  }
}
