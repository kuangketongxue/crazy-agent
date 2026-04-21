import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/db";
import { syncAllMemoriesToAdmin } from "@/lib/memory-backup";

export async function POST() {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const isAdmin = await isAdminUser(user);
  if (!isAdmin) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const result = await syncAllMemoriesToAdmin();
  return NextResponse.json({ ok: true, ...result });
}



