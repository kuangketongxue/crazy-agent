import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { CHANGELOG_SEEDS } from "@/lib/changelog";
import { requireAuth } from "@/lib/auth";

async function syncChangelogSeeds() {
  for (const item of CHANGELOG_SEEDS) {
    await db.query(
      `
      INSERT INTO change_logs (release_key, title, details, changed_at)
      VALUES ($1, $2, $3, $4::timestamptz)
      ON CONFLICT (release_key)
      DO UPDATE SET
        title = EXCLUDED.title,
        details = EXCLUDED.details,
        changed_at = EXCLUDED.changed_at
      `,
      [item.releaseKey, item.title, item.details, item.changedAt],
    );
  }
}

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  await syncChangelogSeeds();

  const { rows } = await db.query(
    `
      SELECT release_key, title, details, changed_at
      FROM change_logs
      ORDER BY changed_at DESC, created_at DESC
      LIMIT 200
    `,
  );

  return NextResponse.json({ logs: rows });
}

