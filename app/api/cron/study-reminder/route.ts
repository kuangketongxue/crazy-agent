import { NextResponse } from "next/server";
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

  return {
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
  };
}

function isQuietHours(hour: number, minute: number) {
  if (hour >= 23) return true;
  if (hour < 4) return true;
  if (hour === 4 && minute < 30) return true;
  return false;
}

function reminderText() {
  return [
    "学习复盘提醒",
    "",
    "过去2小时你学到了什么？",
    "建议快速写3点：",
    "1) 新知识",
    "2) 最大收获",
    "3) 下一步动作",
  ].join("\n");
}

export async function GET(request: Request) {
  const cronHeader = request.headers.get("x-vercel-cron");
  const bearer = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;

  if (!cronHeader && (!secret || bearer !== `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { hour, minute } = getShanghaiNow();
  if (isQuietHours(hour, minute)) {
    return NextResponse.json({ ok: true, skipped: "quiet-hours" });
  }

  const { rows: users } = await db.query(`SELECT user_id FROM profiles`);
  let reminded = 0;

  for (const row of users as Array<{ user_id: string }>) {
    const userId = row.user_id;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO user_schedule_state (user_id, last_study_prompt_at, updated_at)
          VALUES ($1, NULL, now())
          ON CONFLICT (user_id) DO NOTHING
        `,
        [userId],
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
        [userId],
      );

      if (!due.rows.length) {
        await client.query("COMMIT");
        continue;
      }

      const latest = await client.query(
        `SELECT id FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [userId],
      );

      let conversationId: string;
      if (latest.rows.length) {
        conversationId = latest.rows[0].id as string;
      } else {
        const created = await client.query(
          `
            INSERT INTO conversations (user_id, title, updated_at)
            VALUES ($1, $2, now())
            RETURNING id
          `,
          [userId, "学习复盘提醒"],
        );
        conversationId = created.rows[0].id as string;
      }

      await client.query(
        `
          INSERT INTO messages (
            conversation_id, user_id, role, content,
            model_provider, model_id, thinking_seconds,
            prompt_tokens, completion_tokens, total_tokens,
            web_used, files_used, confidence_level, sources
          )
          VALUES (
            $1, $2, 'assistant', $3,
            'system', 'study-reminder-cron', 0,
            0, 0, 0,
            false, false, 'high', '[]'::jsonb
          )
        `,
        [conversationId, userId, reminderText()],
      );
      await client.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
      await client.query("COMMIT");
      reminded += 1;
    } catch {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }

  return NextResponse.json({ ok: true, reminded });
}

