import { randomUUID } from "node:crypto";
import { db, ensureUserProfile } from "../lib/db";
import { forgetLatestMemory, persistAtomicMemories } from "../lib/memory-intelligence";

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const userId = `test_memory_${suffix}`;
  await ensureUserProfile({ userId, email: `memory+${suffix}@example.com` });

  const conversationId = randomUUID();
  const userMessageId = 10001;
  const msg = "我偏好简洁回答。我正在修复 kkagent 项目。我们使用 Python 3.12。";
  await persistAtomicMemories({ userId, conversationId, userMessageId, userMessage: msg });

  const { rows: rows1 } = await db.query(
    `SELECT id, entry_type, content, status FROM memory_entries WHERE user_id = $1 AND status = 'valid' ORDER BY updated_at DESC`,
    [userId],
  );
  if (rows1.length < 3) {
    throw new Error(`expected >=3 atomic memories, got ${rows1.length}`);
  }
  if (!rows1.some((x) => String(x.content).startsWith("Fact:"))) throw new Error("missing Fact memory");
  if (!rows1.some((x) => String(x.content).startsWith("Preference:"))) throw new Error("missing Preference memory");
  if (!rows1.some((x) => String(x.content).startsWith("Context:"))) throw new Error("missing Context memory");

  await forgetLatestMemory(userId);
  const { rows: rows2 } = await db.query(
    `SELECT COUNT(*)::int AS c FROM memory_entries WHERE user_id = $1 AND status = 'valid'`,
    [userId],
  );
  if (Number(rows2[0]?.c || 0) !== rows1.length - 1) {
    throw new Error(`forgetLatestMemory did not reduce valid count: before=${rows1.length}, after=${rows2[0]?.c}`);
  }

  await db.query(`DELETE FROM profiles WHERE user_id = $1`, [userId]);
  console.log("PASS test-memory-loop");
}

main()
  .catch((error) => {
    console.error("FAIL test-memory-loop", error);
    process.exit(1);
  })
  .finally(async () => {
    await db.end().catch(() => undefined);
  });

