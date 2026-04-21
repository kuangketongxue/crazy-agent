import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";

function buildTaskWhere(taskType: string) {
  if (taskType === "web") return `AND m.web_used = TRUE`;
  if (taskType === "file") return `AND m.files_used = TRUE`;
  if (taskType === "local") return `AND m.web_used = FALSE AND m.files_used = FALSE`;
  return "";
}

export async function GET(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const { searchParams } = new URL(request.url);
  const modelFilter = (searchParams.get("model") || "all").trim();
  const taskType = (searchParams.get("taskType") || "all").trim();

  const modelWhere = modelFilter !== "all" ? `AND COALESCE(m.model_id, '') = $2` : "";
  const taskWhere = buildTaskWhere(taskType);
  const params = modelFilter !== "all" ? [user.userId, modelFilter] : [user.userId];

  const { rows: summaryRows } = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE m.role = 'assistant')::int AS answer_count,
        COUNT(*) FILTER (WHERE m.role = 'assistant' AND m.confidence_level = 'high')::int AS high_count,
        COUNT(*) FILTER (WHERE m.role = 'assistant' AND m.confidence_level = 'medium')::int AS medium_count,
        COUNT(*) FILTER (WHERE m.role = 'assistant' AND m.confidence_level = 'low')::int AS low_count,
        COUNT(*) FILTER (WHERE m.role = 'assistant' AND m.web_used = TRUE)::int AS web_count,
        COUNT(*) FILTER (WHERE m.role = 'assistant' AND m.files_used = TRUE)::int AS files_count,
        COALESCE(AVG(NULLIF(m.thinking_seconds, 0)), 0)::numeric(10,2) AS avg_thinking_seconds
      FROM messages m
      WHERE m.user_id = $1
        AND m.created_at >= now() - interval '7 days'
        ${modelWhere}
        ${taskWhere}
    `,
    params,
  );
  const summary = summaryRows[0] || {};
  const total = Number(summary.answer_count || 0);

  const { rows: feedbackRows } = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE af.feedback = 'up')::int AS up_count,
        COUNT(*) FILTER (WHERE af.feedback = 'down')::int AS down_count
      FROM answer_feedback af
      JOIN messages m ON m.id = af.message_id
      WHERE af.user_id = $1
        AND af.created_at >= now() - interval '7 days'
        ${modelWhere}
        ${taskWhere}
    `,
    params,
  );
  const feedback = feedbackRows[0] || {};

  const { rows: dailyRows } = await db.query(
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

  const { rows: dailyQualityRows } = await db.query(
    `
      WITH days AS (
        SELECT generate_series(
          (timezone('Asia/Shanghai', now()))::date - 6,
          (timezone('Asia/Shanghai', now()))::date,
          interval '1 day'
        )::date AS d
      ),
      scored AS (
        SELECT
          (timezone('Asia/Shanghai', m.created_at))::date AS d,
          (
            CASE m.confidence_level
              WHEN 'high' THEN 88
              WHEN 'medium' THEN 72
              ELSE 55
            END
            + CASE WHEN m.web_used THEN 10 ELSE 0 END
            + CASE WHEN m.files_used THEN 8 ELSE 0 END
            + CASE WHEN af.feedback = 'up' THEN 8 WHEN af.feedback = 'down' THEN -8 ELSE 0 END
          )::numeric AS score
        FROM messages m
        LEFT JOIN answer_feedback af ON af.message_id = m.id AND af.user_id = m.user_id
        WHERE m.user_id = $1
          AND m.role = 'assistant'
          AND (timezone('Asia/Shanghai', m.created_at))::date >= (timezone('Asia/Shanghai', now()))::date - 6
          ${modelWhere}
          ${taskWhere}
      )
      SELECT
        to_char(days.d, 'MM-DD') AS day,
        COALESCE(ROUND(AVG(scored.score), 2), 0) AS score
      FROM days
      LEFT JOIN scored ON scored.d = days.d
      GROUP BY days.d
      ORDER BY days.d ASC
    `,
    params,
  );

  const { rows: modelCompareRows } = await db.query(
    `
      SELECT
        COALESCE(model_id, 'unknown') AS model_id,
        COUNT(*)::int AS count,
        ROUND(
          AVG(
            CASE confidence_level
              WHEN 'high' THEN 88
              WHEN 'medium' THEN 72
              ELSE 55
            END
            + CASE WHEN web_used THEN 10 ELSE 0 END
            + CASE WHEN files_used THEN 8 ELSE 0 END
          )::numeric,
          2
        ) AS avg_score
      FROM messages
      WHERE user_id = $1
        AND role = 'assistant'
        AND created_at >= now() - interval '7 days'
      GROUP BY COALESCE(model_id, 'unknown')
      ORDER BY avg_score DESC, count DESC
      LIMIT 8
    `,
    [user.userId],
  );

  const { rows: taskTypeRows } = await db.query(
    `
      SELECT task_type, COUNT(*)::int AS count, ROUND(AVG(score)::numeric, 2) AS avg_score
      FROM (
        SELECT
          CASE
            WHEN web_used THEN 'web'
            WHEN files_used THEN 'file'
            ELSE 'local'
          END AS task_type,
          (
            CASE confidence_level
              WHEN 'high' THEN 88
              WHEN 'medium' THEN 72
              ELSE 55
            END
            + CASE WHEN web_used THEN 10 ELSE 0 END
            + CASE WHEN files_used THEN 8 ELSE 0 END
          )::numeric AS score
        FROM messages
        WHERE user_id = $1
          AND role = 'assistant'
          AND created_at >= now() - interval '7 days'
      ) t
      GROUP BY task_type
      ORDER BY avg_score DESC
    `,
    [user.userId],
  );

  const lowRate = total > 0 ? Number(summary.low_count || 0) / total : 0;
  const weakLinks: string[] = [];
  if (lowRate >= 0.25) weakLinks.push("低把握回答占比偏高，建议提高联网与文件证据比例。");
  if (Number(feedback.down_count || 0) > Number(feedback.up_count || 0)) weakLinks.push("点踩高于点赞，建议回答更短并先给结论。");
  if (total > 0 && Number(summary.web_count || 0) / total < 0.18) weakLinks.push("联网使用偏少，实时信息类问题风险较高。");
  if (weakLinks.length === 0) weakLinks.push("整体质量稳定，继续保持“先结论后依据”的风格。");

  return NextResponse.json({
    period: "最近7天",
    filters: {
      model: modelFilter,
      taskType,
    },
    summary: {
      answers: total,
      confidence: {
        high: Number(summary.high_count || 0),
        medium: Number(summary.medium_count || 0),
        low: Number(summary.low_count || 0),
      },
      webUsedRate: total > 0 ? Math.round((Number(summary.web_count || 0) / total) * 10000) / 100 : 0,
      filesUsedRate: total > 0 ? Math.round((Number(summary.files_count || 0) / total) * 10000) / 100 : 0,
      avgThinkingSeconds: Number(summary.avg_thinking_seconds || 0),
      feedback: {
        up: Number(feedback.up_count || 0),
        down: Number(feedback.down_count || 0),
      },
      satisfactionScore:
        Number(feedback.up_count || 0) + Number(feedback.down_count || 0) > 0
          ? Math.round(
              (Number(feedback.up_count || 0) /
                (Number(feedback.up_count || 0) + Number(feedback.down_count || 0))) *
                10000,
            ) / 100
          : 100,
    },
    dailyTokens: dailyRows.map((r) => ({ day: String(r.day || ""), total_tokens: Number(r.total_tokens || 0) })),
    dailyQuality: dailyQualityRows.map((r) => ({ day: String(r.day || ""), score: Number(r.score || 0) })),
    modelCompare: modelCompareRows.map((r) => ({
      model_id: String(r.model_id || "unknown"),
      count: Number(r.count || 0),
      avg_score: Number(r.avg_score || 0),
    })),
    taskTypeBreakdown: taskTypeRows.map((r) => ({
      task_type: String(r.task_type || "local"),
      count: Number(r.count || 0),
      avg_score: Number(r.avg_score || 0),
    })),
    weakLinks,
  });
}
