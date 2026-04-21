import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { recoverProfileDataByEmail } from "@/lib/db";

export async function POST() {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  try {
    const result = await recoverProfileDataByEmail(user);
    return NextResponse.json({ ok: true, merged: result.merged, restoredMemories: result.restoredMemories || 0 });
  } catch (error) {
    return NextResponse.json({ error: `恢复失败: ${String(error)}` }, { status: 500 });
  }
}
