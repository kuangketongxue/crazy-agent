import { db } from "@/lib/db";
import { backupMemoryEvent } from "@/lib/memory-backup";

type RollupResult = {
  ok: boolean;
  skipped?: string;
  rollupDate: string;
  messageCount: number;
  removedCount: number;
  memoryId?: string;
};

type MessageRow = {
  role: "user" | "assistant" | "system";
  content: string;
};

type MemoryRow = {
  id: string;
  title: string;
  content: string;
  entry_type: string;
  status: string;
  source_pointer: string | null;
};

const STOP_WORDS = new Set([
  "我们",
  "你们",
  "这个",
  "那个",
  "今天",
  "现在",
  "然后",
  "因为",
  "所以",
  "可以",
  "需要",
  "一下",
  "已经",
  "如果",
  "进行",
  "以及",
  "就是",
  "还是",
  "非常",
  "问题",
  "方案",
]);

function getShanghaiNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
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
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
  };
}

function tokenize(text: string) {
  return Array.from(String(text || "").toLowerCase().matchAll(/[a-z0-9\u4e00-\u9fa5]{2,}/g))
    .map((m) => m[0])
    .filter((token) => !STOP_WORDS.has(token));
}

function clipLine(text: string, max = 90) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function buildSummaryFromMessages(rows: MessageRow[], rollupDate: string) {
  const userRows = rows.filter((x) => x.role === "user");
  const assistantRows = rows.filter((x) => x.role === "assistant");

  const topicScore = new Map<string, number>();
  for (const row of userRows) {
    for (const token of tokenize(row.content)) {
      topicScore.set(token, (topicScore.get(token) || 0) + 1);
    }
  }
  const topics = [...topicScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([token]) => token);

  const keyQuestions = userRows.slice(-5).map((x) => clipLine(x.content, 80)).filter(Boolean);
  const keyConclusions = assistantRows.slice(-6).map((x) => clipLine(x.content, 110)).filter(Boolean);

  const reusable = [
    keyQuestions[0] ? `先明确目标问题：${keyQuestions[0]}` : "先明确目标问题，避免泛聊。",
    keyConclusions[0] ? `优先给可执行结论：${keyConclusions[0]}` : "先输出结论，再补关键依据。",
    "每轮对话后沉淀可复用要点到长期记忆，避免重复讨论。",
  ];

  return [
    `日期: ${rollupDate}`,
    "",
    "今日讨论主题:",
    topics.length ? topics.map((x, i) => `${i + 1}. ${x}`).join("\n") : "1. 暂无高频主题",
    "",
    "今日关键问题:",
    keyQuestions.length ? keyQuestions.map((x, i) => `${i + 1}. ${x}`).join("\n") : "1. 暂无",
    "",
    "今日关键结论:",
    keyConclusions.length ? keyConclusions.map((x, i) => `${i + 1}. ${x}`).join("\n") : "1. 暂无",
    "",
    "可复用工作方法:",
    reusable.map((x, i) => `${i + 1}. ${x}`).join("\n"),
  ].join("\n");
}

function coverageRatio(summaryTokens: Set<string>, text: string) {
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  let hit = 0;
  for (const token of tokens) {
    if (summaryTokens.has(token)) hit += 1;
  }
  return hit / tokens.length;
}

export async function runNightlyMemoryRollupForUser(userId: string, options?: { force?: boolean }): Promise<RollupResult> {
  const now = getShanghaiNow();
  const force = Boolean(options?.force);
  if (!force && now.hour < 21) {
    return { ok: true, skipped: "before-night", rollupDate: now.date, messageCount: 0, removedCount: 0 };
  }

  await db.query(
    `
      INSERT INTO nightly_memory_rollup_state (user_id, last_rollup_date, last_run_at, updated_at)
      VALUES ($1, NULL, NULL, now())
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId],
  );

  const due = await db.query(
    `
      UPDATE nightly_memory_rollup_state
      SET
        last_rollup_date = $2::date,
        last_run_at = now(),
        updated_at = now()
      WHERE user_id = $1
        AND ($3::boolean OR last_rollup_date IS DISTINCT FROM $2::date)
      RETURNING user_id
    `,
    [userId, now.date, force],
  );

  if (!due.rows.length) {
    return { ok: true, skipped: "already-rolled", rollupDate: now.date, messageCount: 0, removedCount: 0 };
  }

  const messagesRes = await db.query(
    `
      SELECT role, content
      FROM messages
      WHERE user_id = $1
        AND role IN ('user', 'assistant')
        AND (timezone('Asia/Shanghai', created_at))::date = $2::date
      ORDER BY created_at ASC
      LIMIT 800
    `,
    [userId, now.date],
  );

  const messageRows = messagesRes.rows as MessageRow[];
  if (!messageRows.length) {
    return { ok: true, skipped: "no-messages", rollupDate: now.date, messageCount: 0, removedCount: 0 };
  }

  const summaryContent = buildSummaryFromMessages(messageRows, now.date);
  const summaryTitle = `睡前总复盘-${now.date}`;
  const sourcePointer = `daily-rollup:${now.date}`;

  const upsert = await db.query(
    `
      INSERT INTO memory_entries (user_id, title, content, entry_type, status, importance, source_pointer, updated_at)
      VALUES ($1, $2, $3, 'daily_rollup', 'valid', 0.95, $4, now())
      ON CONFLICT (user_id, source_pointer) WHERE source_pointer IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        status = 'valid',
        importance = LEAST(1.0, memory_entries.importance + 0.02),
        updated_at = now()
      RETURNING id, title, content, entry_type, status, source_pointer
    `,
    [userId, summaryTitle, summaryContent, sourcePointer],
  );

  const summaryEntry = upsert.rows[0] as MemoryRow;

  const candidatesRes = await db.query(
    `
      SELECT id, title, content, entry_type, status, source_pointer
      FROM memory_entries
      WHERE user_id = $1
        AND status = 'valid'
        AND id <> $2::uuid
        AND (timezone('Asia/Shanghai', updated_at))::date = $3::date
      ORDER BY updated_at DESC
      LIMIT 300
    `,
    [userId, summaryEntry.id, now.date],
  );

  const summaryTokens = new Set(tokenize(summaryContent));
  const removeIds: string[] = [];

  for (const row of candidatesRes.rows as MemoryRow[]) {
    if (row.source_pointer === sourcePointer) continue;
    if (String(row.entry_type || "").toLowerCase() === "global_import") continue;
    const ratio = coverageRatio(summaryTokens, `${row.title}\n${row.content}`);
    if (ratio >= 0.62) {
      removeIds.push(row.id);
      await backupMemoryEvent({
        sourceEntryId: row.id,
        sourceUserId: userId,
        title: row.title,
        content: row.content,
        entryType: row.entry_type,
        status: row.status,
        sourcePointer: row.source_pointer,
        action: "delete",
      });
    }
  }

  if (removeIds.length) {
    await db.query(
      `
        UPDATE memory_entries
        SET
          status = 'outdated',
          importance = GREATEST(0.05, LEAST(importance, 0.2)),
          updated_at = now()
        WHERE user_id = $1 AND id = ANY($2::uuid[])
      `,
      [userId, removeIds],
    );
  }

  return {
    ok: true,
    rollupDate: now.date,
    messageCount: messageRows.length,
    removedCount: removeIds.length,
    memoryId: summaryEntry.id,
  };
}
