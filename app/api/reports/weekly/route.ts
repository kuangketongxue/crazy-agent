import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const { rows: summaryRows } = await db.query(
    `
      SELECT
        COUNT(DISTINCT c.id)::int AS conversation_count,
        COUNT(*) FILTER (WHERE m.role = 'user')::int AS user_message_count,
        COUNT(*) FILTER (WHERE m.role = 'assistant')::int AS assistant_message_count,
        COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN m.total_tokens ELSE 0 END), 0)::bigint AS assistant_tokens
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.user_id = $1
        AND c.updated_at >= now() - interval '7 days'
    `,
    [user.userId],
  );
  const summary = summaryRows[0] || {};

  const { rows: topTopicRows } = await db.query(
    `
      SELECT title, updated_at
      FROM conversations
      WHERE user_id = $1
        AND updated_at >= now() - interval '7 days'
      ORDER BY updated_at DESC
      LIMIT 6
    `,
    [user.userId],
  );

  const { rows: decisionRows } = await db.query(
    `
      SELECT key_conclusion, updated_at
      FROM conversation_summaries
      WHERE user_id = $1
        AND updated_at >= now() - interval '7 days'
      ORDER BY updated_at DESC
      LIMIT 5
    `,
    [user.userId],
  );

  const { rows: usageRows } = await db.query(
    `
      SELECT
        to_char(usage_date, 'MM-DD') AS day,
        total_tokens::bigint AS total_tokens
      FROM usage_daily
      WHERE user_id = $1
        AND usage_date >= (timezone('Asia/Shanghai', now()))::date - 6
      ORDER BY usage_date ASC
    `,
    [user.userId],
  );

  const userMessages = Number(summary.user_message_count || 0);
  const assistantMessages = Number(summary.assistant_message_count || 0);
  const avgResponseDepth = userMessages > 0 ? Math.round((assistantMessages / userMessages) * 100) / 100 : 0;

  const suggestions: string[] = [];
  if (avgResponseDepth < 1) suggestions.push("下周优先把问题一次说完整，减少来回补充。");
  else suggestions.push("继续保持提问完整度，减少无效往返。");
  if (Number(summary.assistant_tokens || 0) > 120000) suggestions.push("下周可把高频任务做成模板，控制 token 消耗。");
  else suggestions.push("token 使用较克制，可继续保持。");
  if (!decisionRows.length) suggestions.push("建议每次结束写一条“关键结论”，方便复盘。");

  return NextResponse.json({
    period: "最近7天",
    summary: {
      conversations: Number(summary.conversation_count || 0),
      userMessages,
      assistantMessages,
      assistantTokens: Number(summary.assistant_tokens || 0),
      avgResponseDepth,
    },
    topTopics: topTopicRows.map((r) => ({ title: String(r.title || "未命名对话"), updated_at: r.updated_at })),
    keyDecisions: decisionRows.map((r) => ({ key_conclusion: String(r.key_conclusion || ""), updated_at: r.updated_at })),
    dailyTokens: usageRows.map((r) => ({ day: String(r.day || ""), total_tokens: Number(r.total_tokens || 0) })),
    suggestions,
  });
}
