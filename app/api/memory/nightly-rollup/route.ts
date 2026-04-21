import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { runNightlyMemoryRollupForUser } from "@/lib/nightly-memory";

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const body = await request.json().catch(() => ({}));
  const force = Boolean(body?.force);
  const result = await runNightlyMemoryRollupForUser(user.userId, { force });
  return NextResponse.json(result);
}
