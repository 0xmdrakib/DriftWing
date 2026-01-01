import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

export async function GET() {
  try {
    const manifestPath = path.join(process.cwd(), "public", ".well-known", "farcaster.json");
    const raw = fs.readFileSync(manifestPath, "utf8");
    const data = JSON.parse(raw);
    return NextResponse.json(data, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch {
    return NextResponse.json({ error: "manifest not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
