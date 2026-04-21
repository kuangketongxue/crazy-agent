export type InstalledSkill = {
  id: string;
  name: string;
  source: string;
  purpose: string;
  conversationRule: string;
};

export type CustomSkillPrompt = {
  skillId: string;
  name: string;
  prompt: string;
};

export const REQUIRED_SKILLS: InstalledSkill[] = [
  {
    id: "superpowers",
    name: "Superpowers",
    source: "https://github.com/obra/superpowers",
    purpose: "规范需求澄清、计划执行与结果复盘",
    conversationRule: "先明确目标，再给可执行结果，最后说明验证方式。",
  },
  {
    id: "frontend-design",
    name: "Frontend Design",
    source: "local-plugin:frontend-design-project",
    purpose: "确保界面层级清晰、视觉统一、交互可用",
    conversationRule: "涉及界面时，优先输出结构化、可落地的设计结果。",
  },
  {
    id: "anthropic-skills",
    name: "Anthropic Skills",
    source: "https://github.com/anthropics/skills/tree/main/skills",
    purpose: "补充任务拆解、文档化与工程化流程",
    conversationRule: "回答需要包含步骤、依据与可复查指针。",
  },
  {
    id: "tanweai-pua",
    name: "tanweai/pua",
    source: "https://github.com/tanweai/pua",
    purpose: "强化执行驱动与结果导向表达",
    conversationRule: "保持真实、直接、可执行，不回避问题。",
  },
  {
    id: "web-access",
    name: "web-access",
    source: "https://github.com/eze-is/web-access",
    purpose: "提升联网检索、网页读取和来源回溯能力",
    conversationRule: "需要联网时给出来源、摘要，并把关键事实融入正文。",
  },
];

export function buildSkillSystemPrompt(
  enabledSkills: string[] | null | undefined,
  customSkills: CustomSkillPrompt[] = [],
) {
  const enabledSet = new Set(
    (enabledSkills && enabledSkills.length ? enabledSkills : REQUIRED_SKILLS.map((s) => s.id)).map((x) =>
      x.toLowerCase(),
    ),
  );

  const active = REQUIRED_SKILLS.filter((s) => enabledSet.has(s.id.toLowerCase()));
  const builtinLines = active.map(
    (s, i) => `${i + 1}. ${s.name}：${s.purpose}；规则：${s.conversationRule}`,
  );
  const customLines = customSkills.map(
    (s, i) => `${i + 1}. ${s.name}（${s.skillId}）：${s.prompt.replace(/\n/g, " ")}`,
  );

  return [
    "你必须在每次对话中执行以下技能工作流：",
    ...builtinLines,
    customLines.length ? "" : "",
    ...(customLines.length ? ["用户自定义技能：", ...customLines] : []),
    "",
    "执行要求：",
    "- 回答前结合长期记忆、最近上下文、文件内容和联网信息（如有）。",
    "- 不输出工具内部控制标记、调试标签或函数调用痕迹。",
    "- 回答末尾给清晰结论，必要时给出下一步可执行动作。",
  ].join("\n");
}
