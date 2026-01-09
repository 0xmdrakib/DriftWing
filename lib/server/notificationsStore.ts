export type NotifCadenceHours = 1 | 6 | 12;

export type NotificationDetails = {
  /** Notification endpoint URL provided by Farcaster */
  url: string;
  /** Bearer token to authenticate requests to `url` */
  token: string;
  /** The mini app fid (appFid) that issued the token */
  appFid: number;
};

export type NotifRecord = {
  fid: number;
  appFid: number;
  details: NotificationDetails;
  cadenceHours: NotifCadenceHours;
  nextSendAt: number; // unix seconds
  createdAt: number; // unix seconds
  updatedAt: number; // unix seconds
};

export const NOTIF_KEYS = {
  // Sorted set score = nextSendAt (unix seconds), member = "fid:appFid"
  dueZ: "dw:notif:due",
  // Recent events for debugging (list, most recent first)
  events: "dw:notif:events",
  // Storage for a specific user/app pair
  user: (fid: number, appFid: number) => `dw:notif:user:${fid}:${appFid}`,
  // Member id used in dueZ
  member: (fid: number, appFid: number) => `${fid}:${appFid}`,
} as const;

export function parseMemberId(member: string): { fid: number; appFid: number } | null {
  const [fidStr, appFidStr] = member.split(":");
  const fid = Number(fidStr);
  const appFid = Number(appFidStr);
  if (!Number.isFinite(fid) || !Number.isFinite(appFid)) return null;
  return { fid, appFid };
}

export function clampCadenceHours(x: number): NotifCadenceHours {
  if (x === 1 || x === 6 || x === 12) return x;
  return 6;
}

export async function upsertNotification(
  redis: any,
  args: {
    fid: number;
    details: NotificationDetails;
    cadenceHours: NotifCadenceHours;
    now: number; // unix seconds
  }
): Promise<NotifRecord> {
  const { fid, details, cadenceHours, now } = args;
  const appFid = details.appFid;
  const key = NOTIF_KEYS.user(fid, appFid);

  const existingRaw = (await redis.get(key)) as string | null;
  const existing: NotifRecord | null = existingRaw ? JSON.parse(existingRaw) : null;

  const nextSendAt = existing?.nextSendAt ?? now + cadenceHours * 60 * 60;

  const rec: NotifRecord = {
    fid,
    appFid,
    details,
    cadenceHours,
    nextSendAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await redis.set(key, JSON.stringify(rec));
  await redis.zadd(NOTIF_KEYS.dueZ, { score: rec.nextSendAt, member: NOTIF_KEYS.member(fid, appFid) });

  return rec;
}

export async function loadNotification(redis: any, memberId: string): Promise<NotifRecord | null> {
  const parsed = parseMemberId(memberId);
  if (!parsed) return null;
  const raw = (await redis.get(NOTIF_KEYS.user(parsed.fid, parsed.appFid))) as string | null;
  return raw ? (JSON.parse(raw) as NotifRecord) : null;
}

export async function removeNotification(redis: any, fid: number, appFid: number): Promise<void> {
  await redis.del(NOTIF_KEYS.user(fid, appFid));
  await redis.zrem(NOTIF_KEYS.dueZ, NOTIF_KEYS.member(fid, appFid));
}

export async function pushEvent(redis: any, obj: any): Promise<void> {
  const event = { t: Math.floor(Date.now() / 1000), ...obj };
  await redis.lpush(NOTIF_KEYS.events, JSON.stringify(event));
  // keep the list bounded
  await redis.ltrim(NOTIF_KEYS.events, 0, 199);
}
