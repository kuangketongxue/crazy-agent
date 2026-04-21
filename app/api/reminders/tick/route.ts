import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";

function getShanghaiNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});

  const hour = Number(parts.hour || 0);
  const minute = Number(parts.minute || 0);
  return { now, hour, minute };
}

function isQuietHours(hour: number, minute: number) {
  if (hour >= 23) return true;
  if (hour < 4) return true;
  if (hour === 4 && minute < 30) return true;
  return false;
}

function buildReminderText() {
  return [
    "学习复盘提醒",
    "",
    "过去2小时你学到了什么？",
    "你可以按这个结构快速回复：",
    "1) 学到的关键知识点",
    "2) 今天做对的一件事",
    "3) 下一步最小行动（10~20分钟能完成）",
  ].join("\n");
}

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const { searchParams } = new URL(request.url);
  const preferredConversationId = (searchParams.get("conversationId") || "").trim() || null;

  const { now, hour, minute } = getShanghaiNow();
  if (isQuietHours(hour, minute)) {
    return NextResponse.json({ created: false, reason: "quiet-hours" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO user_schedule_state (user_id, last_study_prompt_at, updated_at)
        VALUES ($1, NULL, now())
        ON CONFLICT (user_id) DO NOTHING
      `,
      [user.userId],
    );

    const due = await client.query(
      `
        UPDATE user_schedule_state
        SET last_study_prompt_at = now(), updated_at = now()
        WHERE user_id = $1
          AND (
            last_study_prompt_at IS NULL
            OR now() - last_study_prompt_at >= interval '2 hours'
          )
        RETURNING user_id
      `,
      [user.userId],
    );

    if (!due.rows.length) {
      await client.query("COMMIT");
      return NextResponse.json({ created: false, reason: "not-due" });
    }

    let conversationId: string | null = null;
    if (preferredConversationId) {
      const { rows } = await client.query(
        `SELECT id FROM conversations WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [preferredConversationId, user.userId],
      );
      if (rows.length) {
        conversationId = rows[0].id as string;
      }
    }

    if (!conversationId) {
      const { rows } = await client.query(
        `SELECT id FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [user.userId],
      );
      if (rows.length) {
        conversationId = rows[0].id as string;
      }
    }

    if (!conversationId) {
      const created = await client.query(
        `
          INSERT INTO conversations (user_id, title, updated_at)
          VALUES ($1, $2, now())
          RETURNING id
        `,
        [user.userId, "学习复盘提醒"],
      );
      conversationId = created.rows[0].id as string;
    }

    const content = buildReminderText();
    const inserted = await client.query(
      `
        INSERT INTO messages (
          conversation_id, user_id, role, content,
          model_provider, model_id, thinking_seconds,
          prompt_tokens, completion_tokens, total_tokens,
          web_used, files_used, confidence_level, sources
        )
        VALUES (
          $1, $2, 'assistant', $3,
          'system', 'study-reminder', 0,
          0, 0, 0,
          false, false, 'high', '[]'::jsonb
        )
        RETURNING id, created_at
      `,
      [conversationId, user.userId, content],
    );

    await client.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);

    await client.query("COMMIT");
    return NextResponse.json({
      created: true,
      conversationId,
      messageId: inserted.rows[0].id,
      content,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return NextResponse.json({ created: false, error: String(error) }, { status: 500 });
  } finally {
    client.release();
  }
}

