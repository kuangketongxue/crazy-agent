import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { backupMemoryEvent } from "@/lib/memory-backup";

const saveSchema = z.object({
  diaryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  successJournal: z.string().max(12000).optional(),
  moneyJournal: z.string().max(12000).optional(),
  gaokaoJournal: z.string().max(12000).optional(),
  section: z.enum(["all", "success", "money", "gaokao"]).optional().default("all"),
});

function toMemoryContent(payload: {
  diaryDate: string;
  successJournal?: string;
  moneyJournal?: string;
  gaokaoJournal?: string;
}) {
  return [
    `日期: ${payload.diaryDate}`,
    "",
    "成功日记:",
    (payload.successJournal || "").trim() || "(空)",
    "",
    "赚钱日记:",
    (payload.moneyJournal || "").trim() || "(空)",
    "",
    "高考日记:",
    (payload.gaokaoJournal || "").trim() || "(空)",
  ].join("\n");
}

function classifyDiaryText(text: string) {
  const t = String(text || "");
  const tags: string[] = [];
  if (/复盘|总结|反思|改进/.test(t)) tags.push("复盘");
  if (/学习|复习|高考|背诵|刷题|笔记/.test(t)) tags.push("学习");
  if (/赚钱|变现|成交|客户|收入|订单|复购/.test(t)) tags.push("变现");
  if (/计划|明天|下一步|安排|目标/.test(t)) tags.push("计划");
  if (/情绪|焦虑|开心|压力|疲惫/.test(t)) tags.push("情绪");
  return tags.length ? tags : ["日常"];
}

export async function GET(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const url = new URL(request.url);
  const diaryDate = (url.searchParams.get("date") || "").trim();

  if (diaryDate) {
    const { rows } = await db.query(
      `
      SELECT diary_date, success_journal, money_journal, gaokao_journal, updated_at
      FROM diary_entries
      WHERE user_id = $1 AND diary_date = $2::date
      LIMIT 1
      `,
      [user.userId, diaryDate],
    );
    return NextResponse.json({ entry: rows[0] || null });
  }

  const { rows } = await db.query(
    `
    SELECT diary_date, success_journal, money_journal, gaokao_journal, updated_at
    FROM diary_entries
    WHERE user_id = $1
    ORDER BY diary_date DESC
    LIMIT 60
    `,
    [user.userId],
  );
  const categorized = (rows || []).map((entry) => ({
    ...entry,
    categories: [
      ...new Set([
        ...classifyDiaryText(entry.success_journal),
        ...classifyDiaryText(entry.money_journal),
        ...classifyDiaryText(entry.gaokao_journal),
      ]),
    ],
  }));
  return NextResponse.json({ entries: rows, categorized });
}

export async function PUT(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const parsed = saveSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const payload = parsed.data;
  const updateSuccess = payload.section === "all" || payload.section === "success";
  const updateMoney = payload.section === "all" || payload.section === "money";
  const updateGaokao = payload.section === "all" || payload.section === "gaokao";

  const { rows } = await db.query(
    `
    INSERT INTO diary_entries (user_id, diary_date, success_journal, money_journal, gaokao_journal, updated_at)
    VALUES ($1, $2::date, $3, $4, $5, now())
    ON CONFLICT (user_id, diary_date)
    DO UPDATE SET
      success_journal = CASE WHEN $6::boolean THEN EXCLUDED.success_journal ELSE diary_entries.success_journal END,
      money_journal = CASE WHEN $7::boolean THEN EXCLUDED.money_journal ELSE diary_entries.money_journal END,
      gaokao_journal = CASE WHEN $8::boolean THEN EXCLUDED.gaokao_journal ELSE diary_entries.gaokao_journal END,
      updated_at = now()
    RETURNING id, diary_date, success_journal, money_journal, gaokao_journal, updated_at
    `,
    [
      user.userId,
      payload.diaryDate,
      updateSuccess ? payload.successJournal ?? "" : "",
      updateMoney ? payload.moneyJournal ?? "" : "",
      updateGaokao ? payload.gaokaoJournal ?? "" : "",
      updateSuccess,
      updateMoney,
      updateGaokao,
    ],
  );

  const saved = rows[0] || null;
  const memoryTitle = `日记-${payload.diaryDate}`;
  const memoryContent = toMemoryContent({
    diaryDate: payload.diaryDate,
    successJournal: saved?.success_journal || "",
    moneyJournal: saved?.money_journal || "",
    gaokaoJournal: saved?.gaokao_journal || "",
  });
  const sourcePointer = `diary:${payload.diaryDate}`;

  let memorySynced = false;
  try {
    const memory = await db.query(
      `
      INSERT INTO memory_entries (user_id, title, content, entry_type, status, source_pointer, updated_at)
      VALUES ($1, $2, $3, 'diary', 'valid', $4, now())
      ON CONFLICT (user_id, source_pointer) WHERE source_pointer IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        status = 'valid',
        importance = LEAST(1.0, memory_entries.importance + 0.03),
        updated_at = now()
      RETURNING id, title, content, entry_type, status, source_pointer
      `,
      [user.userId, memoryTitle, memoryContent, sourcePointer],
    );

    if (memory.rows[0]) {
      await backupMemoryEvent({
        sourceEntryId: memory.rows[0].id,
        sourceUserId: user.userId,
        title: memory.rows[0].title,
        content: memory.rows[0].content,
        entryType: memory.rows[0].entry_type,
        status: memory.rows[0].status,
        sourcePointer: memory.rows[0].source_pointer,
        action: "update",
      });
      memorySynced = true;
    }
  } catch {
    memorySynced = false;
  }

  return NextResponse.json({ ok: true, entry: saved, memorySynced });
}
