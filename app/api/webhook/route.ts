import { NextRequest, NextResponse } from "next/server";
import { parseWebhookEvent, verifyAppKeyWithNeynar } from "@farcaster/miniapp-node";

import { getRedis } from "@/lib/server/redis";
import {
  clampCadenceHours,
  pushEvent,
  removeNotification,
  upsertNotification,
} from "@/lib/server/notificationsStore";

// Webhooks can be retried; keep this handler deterministic + idempotent.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ ok: false, error: "Redis not configured" }, { status: 500 });
  }

  // verifyAppKeyWithNeynar reads NEYNAR_API_KEY from env.
  if (!process.env.NEYNAR_API_KEY) {
    await pushEvent(redis, { type: "webhook_missing_neynar_key" });
    return NextResponse.json({ ok: false, error: "Missing NEYNAR_API_KEY" }, { status: 500 });
  }

  let requestJson: unknown;
  try {
    requestJson = await req.json();
  } catch (err) {
    await pushEvent(redis, { type: "webhook_invalid_json", hint: String(err) });
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  let parsed: any;
  try {
    // parseWebhookEvent expects the already-parsed JSON body + a VerifyAppKey fn.
    parsed = await parseWebhookEvent(requestJson as any, verifyAppKeyWithNeynar as any);
  } catch (err: any) {
    const name = err?.name ?? "ParseWebhookEventError";
    const message = err?.message ?? String(err);

    await pushEvent(redis, { type: "webhook_parse_error", hint: `${name}: ${message}` });

    const isAuth =
      /unauthorized/i.test(name) ||
      /invalid.*signature/i.test(name) ||
      /app.*key/i.test(name) ||
      /unauthorized/i.test(message) ||
      /invalid.*signature/i.test(message) ||
      /app.*key/i.test(message);

    return NextResponse.json({ ok: false, error: name }, { status: isAuth ? 401 : 400 });
  }

  const event = parsed?.event ?? parsed;
  const eventName = (event?.event ?? "webhook") as string;
  const fidRaw = parsed?.fid ?? event?.fid;
  const details = event?.notificationDetails;

  // `parseWebhookEvent()` returns the client app FID at the top-level (not inside `notificationDetails`).
  // Base docs: always use (fid, appFid) together to uniquely identify a user-client combination.
  const appFidRaw = parsed?.appFid ?? (event as any)?.appFid;

  const fid = Number(fidRaw);
  const appFid = Number(appFidRaw);

  // If the user enabled notifications, Farcaster includes notificationDetails.
  if (Number.isFinite(fid) && Number.isFinite(appFid) && details?.token && details?.url) {
    const cadenceHours = clampCadenceHours(Number(process.env.NOTIF_CADENCE_HOURS ?? "6"));
    const now = Math.floor(Date.now() / 1000);

    const rec = await upsertNotification(redis, {
      fid,
      details: { token: details.token, url: details.url, appFid },
      cadenceHours,
      now,
    });

    await pushEvent(redis, {
      type: eventName,
      fid,
      appFid,
      cadenceHours,
      nextSendAt: rec.nextSendAt,
    });

    return NextResponse.json({ ok: true });
  }

  // If the user disabled notifications or removed the miniapp, clean up.
  if (
    Number.isFinite(fid) &&
    Number.isFinite(appFid) &&
    (eventName.includes("disabled") || eventName.includes("removed"))
  ) {
    await removeNotification(redis, fid, appFid);
    await pushEvent(redis, { type: eventName, fid, appFid, removed: true });
    return NextResponse.json({ ok: true });
  }

  await pushEvent(redis, { type: eventName, fid: fidRaw, appFid: appFidRaw, hasDetails: !!details });
  return NextResponse.json({ ok: true });
}
