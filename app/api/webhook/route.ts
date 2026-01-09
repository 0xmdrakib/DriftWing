import { NextResponse } from "next/server";
import { parseWebhookEvent, verifyAppKeyWithNeynar } from "@farcaster/miniapp-node";
import { getRedis } from "@/lib/server/redis";
import { clampCadenceHours, pushEvent, upsertNotification } from "@/lib/server/notificationsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const redis = getRedis();
  if (!redis) return NextResponse.json({ ok: false, error: "Redis not configured" }, { status: 500 });

  const neynarApiKey = process.env.NEYNAR_API_KEY;
  if (!neynarApiKey) return NextResponse.json({ ok: false, error: "NEYNAR_API_KEY missing" }, { status: 500 });

  const rawBody = await req.text();

  const parsed = await parseWebhookEvent(rawBody, req.headers);
  if (!parsed.isValid) {
    await pushEvent(redis, { type: "webhook_invalid_signature", hint: parsed.reason ?? "unknown" });
    return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  const event = parsed.event;

  // Double-check the app key with Neynar for safety
  const appKey = event.appKey;
  if (!appKey) {
    await pushEvent(redis, { type: "webhook_missing_appKey" });
    return NextResponse.json({ ok: false, error: "Missing appKey" }, { status: 400 });
  }

  const appKeyOk = await verifyAppKeyWithNeynar({ neynarApiKey, appKey });
  if (!appKeyOk) {
    await pushEvent(redis, { type: "webhook_appKey_invalid", appKey });
    return NextResponse.json({ ok: false, error: "Invalid app key" }, { status: 401 });
  }

  const fid = event.fid;
  const details = event.notificationDetails;

  if (fid && details?.token && details?.url && details?.appFid) {
    const cadenceHours = clampCadenceHours(Number(process.env.NOTIF_CADENCE_HOURS ?? "6"));
    const now = Math.floor(Date.now() / 1000);

    const rec = await upsertNotification(redis, {
      fid,
      details: { token: details.token, url: details.url, appFid: details.appFid },
      cadenceHours,
      now,
    });

    await pushEvent(redis, { type: event.event, fid, appFid: details.appFid, cadenceHours, nextSendAt: rec.nextSendAt });
  } else {
    await pushEvent(redis, { type: event.event, fid, hasDetails: !!details });
  }

  return NextResponse.json({ ok: true });
}
