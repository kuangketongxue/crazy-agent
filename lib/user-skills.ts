import { db } from "@/lib/db";

export type CustomSkill = {
  id: string;
  skill_id: string;
  name: string;
  description: string;
  prompt: string;
};

function toSkillId(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `custom-${base || `skill-${Date.now()}`}`;
}

export function shouldCreateSkillByMessage(text: string) {
  return /(创建|新建|自创|写一个).{0,8}(skill|技能)/i.test(text);
}

export function parseSkillFromMessage(text: string) {
  const nameMatch =
    text.match(/(?:叫|名为|名称[:：]|name[:：])\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{2,48})/i) ||
    text.match(/(?:skill|技能)\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{2,48})/i);
  const name = nameMatch?.[1] || `自定义技能-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  const description =
    text.replace(/\s+/g, " ").slice(0, 280) || "来自对话创建的自定义技能";

  const prompt = [
    `技能名称: ${name}`,
    "执行原则:",
    "1) 先确认目标与边界，再执行。",
    "2) 输出可直接落地的结果，不要空泛。",
    "3) 关键步骤给出验证方法。",
    `用户原始需求摘要: ${description}`,
  ].join("\n");

  return { name, description, prompt, skillId: toSkillId(name) };
}

export async function upsertCustomSkill(userId: string, input: { skillId: string; name: string; description: string; prompt: string }) {
  const { rows } = await db.query(
    `
      INSERT INTO custom_skills (user_id, skill_id, name, description, prompt, updated_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (user_id, skill_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        prompt = EXCLUDED.prompt,
        updated_at = now()
      RETURNING id, skill_id, name, description, prompt
    `,
    [userId, input.skillId, input.name, input.description, input.prompt],
  );
  return rows[0] as CustomSkill;
}

export async function listCustomSkills(userId: string) {
  const { rows } = await db.query(
    `SELECT id, skill_id, name, description, prompt FROM custom_skills WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`,
    [userId],
  );
  return rows as CustomSkill[];
}
