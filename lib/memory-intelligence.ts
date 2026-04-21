import { db } from "@/lib/db";
import { backupMemoryEvent } from "@/lib/memory-backup";

export type ActiveMemoryRow = {
  id: string;
  title: string;
  content: string;
  entry_type: string;
  source_pointer: string | null;
};

type AtomicMemories = {
  facts: string[];
  preferences: string[];
  contexts: string[];
};

function tokenize(text: string) {
  return Array.from(String(text || "").toLowerCase().matchAll(/[a-z0-9\u4e00-\u9fa5]{2,}/g)).map((m) => m[0]);
}

function uniq(values: string[]) {
  return [...new Set(values.map((x) => x.trim()).filter(Boolean))];
}

function normalizeMemoryText(input: string) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccardSimilarity(a: string, b: string) {
  const aa = new Set(normalizeMemoryText(a).split(" ").filter(Boolean));
  const bb = new Set(normalizeMemoryText(b).split(" ").filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const token of aa) {
    if (bb.has(token)) intersection += 1;
  }
  return intersection / (aa.size + bb.size - intersection);
}

function splitSentences(input: string) {
  return uniq(
    String(input || "")
      .split(/[\n.!?;\u3002\uff01\uff1f\uff1b]+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 3 && x.length <= 180 && !/[?？]$/.test(x)),
  );
}

function containsAny(text: string, words: string[]) {
  return words.some((w) => text.includes(w));
}

const FORGET_WORDS = [
  "\u5fd8\u4e86\u521a\u624d\u90a3\u4e2a",
  "\u5fd8\u6389\u521a\u624d",
  "forget that",
  "\u4e0d\u8981\u8bb0\u4f4f\u521a\u624d",
  "\u5220\u9664\u521a\u624d\u8bb0\u5fc6",
];

const PREFERENCE_WORDS = [
  "\u504f\u597d",
  "\u559c\u6b22",
  "\u4e0d\u559c\u6b22",
  "\u4e0d\u8981",
  "\u5fc5\u987b",
  "\u4f18\u5148",
  "\u4e60\u60ef",
  "\u7981\u5fcc",
  "\u8bf7\u7528",
  "\u8bf7\u4e0d\u8981",
];

const CONTEXT_WORDS = [
  "\u6b63\u5728",
  "\u76ee\u524d",
  "\u73b0\u5728",
  "\u9636\u6bb5",
  "\u8ba1\u5212",
  "\u63a5\u4e0b\u6765",
  "\u672c\u5468",
  "\u4eca\u5929",
  "\u672c\u6708",
  "\u4e0a\u7ebf\u4e2d",
  "\u6392\u67e5\u4e2d",
  "\u4fee\u590d\u4e2d",
];

const FACT_WORDS = [
  "\u6211\u662f",
  "\u6211\u5728",
  "\u9879\u76ee",
  "\u7248\u672c",
  "\u4f7f\u7528",
  "\u57fa\u4e8e",
  "\u8d26\u53f7",
  "\u90ae\u7bb1",
  "\u57ce\u5e02",
  "\u65f6\u533a",
  "\u73af\u5883",
  "\u6a21\u578b",
];

export function shouldForgetRecentlyAddedMemory(message: string) {
  const text = String(message || "").toLowerCase();
  return FORGET_WORDS.some((word) => text.includes(word.toLowerCase()));
}

export function extractAtomicMemories(message: string): AtomicMemories {
  const parts = splitSentences(message);
  const facts: string[] = [];
  const preferences: string[] = [];
  const contexts: string[] = [];
  for (const line of parts) {
    if (containsAny(line, PREFERENCE_WORDS)) {
      preferences.push(line);
      continue;
    }
    if (containsAny(line, CONTEXT_WORDS)) {
      contexts.push(line);
      continue;
    }
    if (containsAny(line, FACT_WORDS)) {
      facts.push(line);
    }
  }
  return {
    facts: uniq(facts).slice(0, 8),
    preferences: uniq(preferences).slice(0, 8),
    contexts: uniq(contexts).slice(0, 8),
  };
}

export async function forgetLatestMemory(userId: string) {
  const current = await db.query(
    `
      SELECT id, title, content, entry_type, status, source_pointer
      FROM memory_entries
      WHERE user_id = $1 AND status = 'valid'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [userId],
  );
  const target = current.rows[0];
  if (!target) return null;
  await db.query(`UPDATE memory_entries SET status = 'outdated', updated_at = now() WHERE id = $1`, [target.id]);
  await backupMemoryEvent({
    sourceEntryId: target.id,
    sourceUserId: userId,
    title: target.title,
    content: target.content,
    entryType: target.entry_type,
    status: "outdated",
    sourcePointer: target.source_pointer,
    action: "update",
  });
  return target;
}

export async function persistAtomicMemories(params: {
  userId: string;
  conversationId: string;
  userMessageId: number;
  userMessage: string;
}) {
  const parsed = extractAtomicMemories(params.userMessage);
  const payload: Array<{ type: "fact" | "preference" | "context"; text: string }> = [
    ...parsed.facts.map((text) => ({ type: "fact" as const, text })),
    ...parsed.preferences.map((text) => ({ type: "preference" as const, text })),
    ...parsed.contexts.map((text) => ({ type: "context" as const, text })),
  ];
  for (let i = 0; i < payload.length; i += 1) {
    const item = payload[i];
    const pointer = `atomic:${item.type}:conversation:${params.conversationId}#message:${params.userMessageId}:idx:${i + 1}`;
    const title = `${item.type.toUpperCase()}-${new Date().toISOString().slice(0, 10)}-${i + 1}`;
    const content = `${item.type === "fact" ? "Fact" : item.type === "preference" ? "Preference" : "Context"}: ${item.text}`;
    const existed = await db.query(
      `
        SELECT id, content
        FROM memory_entries
        WHERE user_id = $1
          AND status = 'valid'
          AND (
            content = $2
            OR lower(regexp_replace(content, '\s+', ' ', 'g')) = lower(regexp_replace($2, '\s+', ' ', 'g'))
          )
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [params.userId, content],
    );
    if (existed.rows[0]) continue;
    const recent = await db.query(
      `
        SELECT id, content
        FROM memory_entries
        WHERE user_id = $1
          AND status = 'valid'
        ORDER BY updated_at DESC
        LIMIT 300
      `,
      [params.userId],
    );
    const fuzzyDupe = recent.rows.find((row) => jaccardSimilarity(String(row.content || ""), content) >= 0.92);
    if (fuzzyDupe) continue;
    const inserted = await db.query(
      `
        INSERT INTO memory_entries (user_id, title, content, entry_type, source_pointer, status, importance)
        VALUES ($1, $2, $3, $4, $5, 'valid', 0.72)
        ON CONFLICT (user_id, source_pointer) WHERE source_pointer IS NOT NULL
        DO UPDATE SET
          content = EXCLUDED.content,
          status = 'valid',
          importance = LEAST(1.0, memory_entries.importance + 0.03),
          updated_at = now()
        RETURNING id, title, content, entry_type, status, source_pointer
      `,
      [params.userId, title, content, item.type, pointer],
    );
    if (inserted.rows[0]) {
      await backupMemoryEvent({
        sourceEntryId: inserted.rows[0].id,
        sourceUserId: params.userId,
        title: inserted.rows[0].title,
        content: inserted.rows[0].content,
        entryType: inserted.rows[0].entry_type,
        status: inserted.rows[0].status,
        sourcePointer: inserted.rows[0].source_pointer,
        action: "update",
      });
    }
  }
}

export function buildMemoryRecallContext(query: string, rows: ActiveMemoryRow[]) {
  const qTokens = new Set(tokenize(query));
  const scored = rows
    .map((row) => {
      const tokens = tokenize(`${row.title}\n${row.content}`);
      let hit = 0;
      for (const tk of tokens) {
        if (qTokens.has(tk)) hit += 1;
      }
      const bonus =
        row.entry_type === "preference" ? 4 : row.entry_type === "context" ? 3 : row.entry_type === "fact" ? 2 : 0;
      return { row, score: hit + bonus };
    })
    .sort((a, b) => b.score - a.score);

  const relevant = scored.filter((x) => x.score > 0).slice(0, 24).map((x) => x.row);
  const indexed = rows.map((row, i) => `${i + 1}. [${row.entry_type}] ${row.title} -> ${row.source_pointer || row.id}`).join("\n");
  const detailed = relevant
    .map((row, i) => `${i + 1}) [${row.entry_type}] ${row.title}\n${row.content}\n索引: ${row.source_pointer || row.id}`)
    .join("\n\n");

  return {
    allIds: rows.map((x) => x.id),
    context: [
      `有效长期记忆总数: ${rows.length}`,
      `强相关记忆:\n${detailed || "(无强相关记忆，需参考全量索引)"}`,
      `全部有效记忆索引:\n${indexed || "(暂无有效记忆)"}`,
    ].join("\n\n"),
  };
}
