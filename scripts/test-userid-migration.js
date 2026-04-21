(async () => {
  const dbModuleRaw = await import('../lib/db.ts');
  const dbModule = dbModuleRaw.default || dbModuleRaw['module.exports'] || dbModuleRaw;
  const { db, ensureUserProfile } = dbModule;

  const stamp = Date.now();
  const oldUserId = `legacy-admin-${stamp}`;
  const newUserId = `new-admin-${stamp}`;
  const email = `admin-migrate-${stamp}@example.com`;

  try {
    await ensureUserProfile({ userId: oldUserId, email });

    await db.query(`UPDATE profiles SET created_at = now() - interval '60 days' WHERE user_id = $1`, [oldUserId]);

    await db.query(
      `UPDATE user_settings
       SET system_prompt = $2, auto_web = false, openrouter_key = $3, nvidia_key = $4, tavily_key = $5
       WHERE user_id = $1`,
      [oldUserId, 'legacy-prompt', 'or-legacy', 'nv-legacy', 'tv-legacy'],
    );

    const convo = await db.query(
      `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
      [oldUserId, 'legacy convo'],
    );
    const convoId = convo.rows[0].id;

    await db.query(
      `INSERT INTO messages (conversation_id, user_id, role, content, total_tokens)
       VALUES ($1, $2, 'user', $3, 123), ($1, $2, 'assistant', $4, 456)`,
      [convoId, oldUserId, 'hello', 'world'],
    );

    await db.query(
      `INSERT INTO memory_entries (user_id, title, content, entry_type)
       VALUES ($1, 'legacy-memory', 'remember this', 'note')`,
      [oldUserId],
    );

    await db.query(
      `INSERT INTO usage_daily (user_id, usage_date, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, CURRENT_DATE, 10, 20, 30)
       ON CONFLICT (user_id, usage_date)
       DO UPDATE SET total_tokens = usage_daily.total_tokens + 30`,
      [oldUserId],
    );

    await db.query(
      `UPDATE usage_total
       SET prompt_tokens = 100, completion_tokens = 200, total_tokens = 300
       WHERE user_id = $1`,
      [oldUserId],
    );

    await ensureUserProfile({ userId: newUserId, email });

    const profile = await db.query(`SELECT user_id, email, created_at FROM profiles WHERE user_id = $1`, [newUserId]);
    const oldProfile = await db.query(`SELECT user_id FROM profiles WHERE user_id = $1`, [oldUserId]);
    const settings = await db.query(`SELECT system_prompt, auto_web, openrouter_key, nvidia_key, tavily_key FROM user_settings WHERE user_id = $1`, [newUserId]);
    const convoCount = await db.query(`SELECT COUNT(*)::int AS c FROM conversations WHERE user_id = $1`, [newUserId]);
    const messageCount = await db.query(`SELECT COUNT(*)::int AS c FROM messages WHERE user_id = $1`, [newUserId]);
    const memoryCount = await db.query(`SELECT COUNT(*)::int AS c FROM memory_entries WHERE user_id = $1`, [newUserId]);
    const usageTotal = await db.query(`SELECT total_tokens FROM usage_total WHERE user_id = $1`, [newUserId]);

    const result = {
      ok: true,
      migratedProfileExists: profile.rows.length === 1,
      oldProfileRemoved: oldProfile.rows.length === 0,
      settings: settings.rows[0] || null,
      conversationCount: convoCount.rows[0]?.c || 0,
      messageCount: messageCount.rows[0]?.c || 0,
      memoryCount: memoryCount.rows[0]?.c || 0,
      usageTotal: usageTotal.rows[0]?.total_tokens || 0,
      createdAt: profile.rows[0]?.created_at || null,
    };

    console.log(JSON.stringify(result, null, 2));

    await db.query(`DELETE FROM messages WHERE user_id = $1 OR user_id = $2`, [oldUserId, newUserId]);
    await db.query(`DELETE FROM conversations WHERE user_id = $1 OR user_id = $2`, [oldUserId, newUserId]);
    await db.query(`DELETE FROM uploaded_files WHERE user_id = $1 OR user_id = $2`, [oldUserId, newUserId]);
    await db.query(`DELETE FROM memory_entries WHERE user_id = $1 OR user_id = $2`, [oldUserId, newUserId]);
    await db.query(`DELETE FROM usage_daily WHERE user_id = $1 OR user_id = $2`, [oldUserId, newUserId]);
    await db.query(`DELETE FROM usage_total WHERE user_id = $1 OR user_id = $2`, [oldUserId, newUserId]);
    await db.query(`DELETE FROM user_settings WHERE user_id = $1 OR user_id = $2`, [oldUserId, newUserId]);
    await db.query(`DELETE FROM profiles WHERE user_id = $1 OR user_id = $2`, [oldUserId, newUserId]);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
