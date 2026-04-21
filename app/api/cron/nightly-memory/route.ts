import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runNightlyMemoryRollupForUser } from "@/lib/nightly-memory";

export async function GET(request: Request) {
  const cronHeader = request.headers.get("x-vercel-cron");
  const bearer = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;

  if (!cronHeader && (!secret || bearer !== `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const users = await db.query(`SELECT user_id FROM profiles`);
  let rolled = 0;
  let skipped = 0;

  for (const row of users.rows as Array<{ user_id: string }>) {
    try {
      const result = await runNightlyMemoryRollupForUser(row.user_id);
      if (result.skipped) skipped += 1;
      else rolled += 1;
    } catch {
      skipped += 1;
    }
  }

  return NextResponse.json({ ok: true, rolled, skipped, total: users.rows.length });
}
