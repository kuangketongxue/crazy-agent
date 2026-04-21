import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const url = new URL(request.url);
  const conversationId = (url.searchParams.get("conversationId") || "").trim();
  const endpoint = conversationId
    ? `/api/reminders/tick?conversationId=${encodeURIComponent(conversationId)}`
    : "/api/reminders/tick";

  const target = new URL(endpoint, url.origin);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      cookie: request.headers.get("cookie") || "",
    },
  });

  const data = await response.json().catch(() => ({}));
  return NextResponse.json(data, { status: response.status });
}

