import { NextResponse } from "next/server";
import { delKey, getJson, setJson, storageDebugInfo } from "@/lib/storage";

export const runtime = "nodejs";

function errorDetails(err: unknown) {
  const e: any = err;
  const message = err instanceof Error ? err.message : String(err);
  const cause = e?.cause;
  const causeObj = cause
    ? {
        name: cause?.name,
        message: cause?.message ?? String(cause),
        code: cause?.code,
        errno: cause?.errno,
        syscall: cause?.syscall,
      }
    : null;
  return { message, cause: causeObj };
}

export async function GET() {
  const info = storageDebugInfo();
  const key = `dw:health:${Date.now()}:${Math.random().toString(16).slice(2)}`;

  try {
    await setJson(key, { ok: true, t: Date.now() });
    const got = await getJson<any>(key);
    await delKey(key);

    return NextResponse.json({
      ok: true,
      storage: info,
      roundTrip: {
        wrote: true,
        readBack: got,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        storage: info,
        error: errorDetails(err),
      },
      { status: 500 }
    );
  }
}
