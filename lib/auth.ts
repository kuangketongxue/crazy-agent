import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ensureUserProfile, getUserBlockState, recoverProfileDataByEmail, type AuthUser } from "@/lib/db";

declare global {
  // eslint-disable-next-line no-var
  var __profileRecoveryCache: Map<string, number> | undefined;
}

export async function requireAuth(): Promise<AuthUser | NextResponse> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  const authUser: AuthUser = { userId, email };
  await ensureUserProfile(authUser);
  const blockState = await getUserBlockState(userId);
  if (blockState.blocked) {
    return NextResponse.json(
      {
        error: "账号已被管理员限制使用",
        reason: blockState.reason || "违规使用",
      },
      { status: 403 },
    );
  }
  if (email) {
    const cache = global.__profileRecoveryCache ?? new Map<string, number>();
    global.__profileRecoveryCache = cache;
    const cacheKey = `${userId}:${email.toLowerCase()}`;
    const lastRunAt = cache.get(cacheKey) ?? 0;
    if (Date.now() - lastRunAt > 10 * 60 * 1000) {
      cache.set(cacheKey, Date.now());
      try {
        await recoverProfileDataByEmail(authUser);
      } catch (error) {
        console.error("[auth] profile recovery skipped", error);
      }
    }
  }
  return authUser;
}
