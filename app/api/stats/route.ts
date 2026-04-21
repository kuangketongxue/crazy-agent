import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { rows } = await db.query(
    `
      SELECT
        COALESCE(SUM(prompt_tokens) FILTER (
          WHERE role = 'assistant'
            AND (timezone('Asia/Shanghai', created_at))::date = (timezone('Asia/Shanghai', now()))::date
        ), 0) AS today_prompt_tokens,
        COALESCE(SUM(completion_tokens) FILTER (
          WHERE role = 'assistant'
            AND (timezone('Asia/Shanghai', created_at))::date = (timezone('Asia/Shanghai', now()))::date
        ), 0) AS today_completion_tokens,
        COALESCE(SUM(total_tokens) FILTER (
          WHERE role = 'assistant'
            AND (timezone('Asia/Shanghai', created_at))::date = (timezone('Asia/Shanghai', now()))::date
        ), 0) AS today_total_tokens,
        COALESCE(SUM(prompt_tokens) FILTER (WHERE role = 'assistant'), 0) AS all_prompt_tokens,
        COALESCE(SUM(completion_tokens) FILTER (WHERE role = 'assistant'), 0) AS all_completion_tokens,
        COALESCE(SUM(total_tokens) FILTER (WHERE role = 'assistant'), 0) AS all_total_tokens,
        MAX(created_at) FILTER (WHERE role = 'assistant') AS latest_usage_at
      FROM messages
      WHERE user_id = $1
    `,
    [user.userId],
  );
  const row = rows[0] || {};

  return NextResponse.json({
    today: {
      prompt_tokens: Number(row.today_prompt_tokens || 0),
      completion_tokens: Number(row.today_completion_tokens || 0),
      total_tokens: Number(row.today_total_tokens || 0),
    },
    total: {
      prompt_tokens: Number(row.all_prompt_tokens || 0),
      completion_tokens: Number(row.all_completion_tokens || 0),
      total_tokens: Number(row.all_total_tokens || 0),
      updated_at: row.latest_usage_at || null,
    },
  });
}

