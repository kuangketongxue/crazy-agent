import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

let closeDb: null | (() => Promise<void>) = null;

function loadEnvFromFile(path: string) {
  if (!path || !existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadEnvFromFile(process.env.DOTENV_CONFIG_PATH || ".env.vercel.production");
  const { db, ensureUserProfile, isAdminUser, isDesignatedAdminEmail } = await import("../lib/db");
  closeDb = () => db.end();
  const { saveTraitSummary } = await import("../lib/traits");
  const { saveConversationExperience } = await import("../lib/experience");

  const suffix = randomUUID().slice(0, 8);
  const normalUserId = `test_user_${suffix}`;
  const conversationId = randomUUID();
  const messageId = 10001;

  await ensureUserProfile({ userId: normalUserId, email: `normal+${suffix}@example.com` });

  const normalAdmin = await isAdminUser({ userId: normalUserId, email: `normal+${suffix}@example.com` });
  if (normalAdmin) {
    throw new Error("normal test user was incorrectly treated as admin");
  }
  if (!isDesignatedAdminEmail("kuangketongxue@gmail.com")) {
    throw new Error("admin email rule is broken");
  }

  await saveTraitSummary({
    userId: normalUserId,
    conversationId,
    userMessageId: messageId,
    userMessage: "请给我一个可验证的修复方案",
    systemPrompt: "你是助手",
  });
  await saveTraitSummary({
    userId: normalUserId,
    conversationId,
    userMessageId: messageId,
    userMessage: "请给我一个可验证的修复方案（重复）",
    systemPrompt: "你是助手",
  });

  await saveConversationExperience({
    userId: normalUserId,
    conversationId,
    userMessageId: messageId,
    userMessage: "第一次提问",
    assistantMessage: "第一次回答",
  });
  await saveConversationExperience({
    userId: normalUserId,
    conversationId,
    userMessageId: messageId,
    userMessage: "第二次提问",
    assistantMessage: "第二次回答",
  });

  const traitPointer = `trait:conversation:${conversationId}#message:${messageId}`;
  const expPointer = `experience:conversation:${conversationId}#message:${messageId}`;
  const { rows } = await db.query(
    `
      SELECT source_pointer, COUNT(*)::int AS cnt, MAX(content) AS content
      FROM memory_entries
      WHERE user_id = $1
        AND source_pointer IN ($2, $3)
      GROUP BY source_pointer
      ORDER BY source_pointer ASC
    `,
    [normalUserId, traitPointer, expPointer],
  );

  const traitCount = Number(rows.find((r) => r.source_pointer === traitPointer)?.cnt || 0);
  const expCount = Number(rows.find((r) => r.source_pointer === expPointer)?.cnt || 0);
  if (traitCount !== 1 || expCount !== 1) {
    throw new Error(`unique pointer protection failed: trait=${traitCount}, experience=${expCount}`);
  }

  const traitContent = String(rows.find((r) => r.source_pointer === traitPointer)?.content || "");
  if (!traitContent.includes("出现情境:") || !traitContent.includes("对应工作流:") || !traitContent.includes("素材指针:")) {
    throw new Error(`trait summary missing required fields: ${traitContent}`);
  }

  await db.query(`DELETE FROM profiles WHERE user_id = $1`, [normalUserId]);

  console.log("PASS test-chat-unblock", {
    normalAdmin,
    traitCount,
    expCount,
  });
}

main()
  .catch(async (error) => {
    console.error("FAIL test-chat-unblock", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (closeDb) {
      await closeDb().catch(() => undefined);
    }
  });
