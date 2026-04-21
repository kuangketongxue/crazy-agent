"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignOutButton, UserButton, useUser } from "@clerk/nextjs";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Copy,
  ChevronDown,
  RefreshCw,
  CheckCircle2,
  Globe,
  Loader2,
  Mic,
  Pencil,
  Plus,
  Save,
  Search,
  Send,
  Settings,
  Shield,
  Trash2,
  ThumbsUp,
  ThumbsDown,
  Upload,
  X,
} from "lucide-react";
import { VoiceButton } from "@/components/voice-button";
import { voiceService } from "@/lib/voice-service";

type Conversation = {
  id: string;
  title: string;
  updated_at: string;
  is_favorite?: boolean;
  latest_message?: string;
};

type Message = {
  id: number | string;
  role: "user" | "assistant" | "system";
  content: string;
  model_provider?: string | null;
  model_id?: string | null;
  web_used?: boolean;
  files_used?: boolean;
  confidence_level?: "high" | "medium" | "low" | string;
  feedback?: "up" | "down" | null;
  sources?: Array<{ title: string; url: string; snippet: string }>;
  mindmap_url?: string | null;
  mindmap_prompt?: string | null;
  created_at: string;
};

type MemoryEntry = {
  id: string;
  title: string;
  content: string;
  entry_type: string;
  status?: "valid" | "outdated" | string;
  importance?: number;
  source_pointer?: string | null;
  updated_at: string;
};

type UsageData = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

type ToastState = {
  type: "success" | "error";
  text: string;
};

type ChangeLogItem = {
  release_key: string;
  title: string;
  details: string;
  changed_at: string;
};

type QualityData = {
  availability24h: number;
  switchSuccess24h: number;
};

type PetState = {
  species: string;
  name: string;
  mood: string;
  energy: number;
  level?: number;
  xp?: number;
  xpToNext?: number;
  rarity?: string;
  trait_focus?: string;
  trait_weakness?: string;
  attributes?: {
    debugging: number;
    patience: number;
    chaos: number;
    wisdom: number;
    snark: number;
  };
  emoji?: string;
  trait?: string;
};

type QualityReview = {
  period: string;
  summary: {
    answers: number;
    confidence: { high: number; medium: number; low: number };
    webUsedRate: number;
    filesUsedRate: number;
    avgThinkingSeconds: number;
    feedback: { up: number; down: number };
    satisfactionScore: number;
  };
  dailyTokens: Array<{ day: string; total_tokens: number }>;
  dailyQuality: Array<{ day: string; score: number }>;
  modelCompare?: Array<{ model_id: string; count: number; avg_score: number }>;
  taskTypeBreakdown?: Array<{ task_type: string; count: number; avg_score: number }>;
  weakLinks: string[];
};

type WeeklyReport = {
  period: string;
  summary: {
    conversations: number;
    userMessages: number;
    assistantMessages: number;
    assistantTokens: number;
    avgResponseDepth: number;
  };
  topTopics: Array<{ title: string; updated_at?: string }>;
  keyDecisions: Array<{ key_conclusion: string; updated_at?: string }>;
  dailyTokens: Array<{ day: string; total_tokens: number }>;
  suggestions: string[];
};

type RadarMetrics = {
  confidence: number;
  sourceCoverage: number;
  timeliness: number;
  verifiability: number;
  consistency: number;
};

const radarAxis = [
  { key: "confidence", label: "把握度" },
  { key: "sourceCoverage", label: "来源覆盖" },
  { key: "timeliness", label: "时效性" },
  { key: "verifiability", label: "可复核性" },
  { key: "consistency", label: "一致性" },
] as const;

function buildRadarPoints(metrics: RadarMetrics, radius: number, center: number) {
  return radarAxis
    .map((axis, index) => {
      const angle = (-90 + (360 / radarAxis.length) * index) * (Math.PI / 180);
      const raw = Number(metrics[axis.key] || 0);
      const value = Math.max(0, Math.min(100, raw));
      const r = (value / 100) * radius;
      const x = center + r * Math.cos(angle);
      const y = center + r * Math.sin(angle);
      return `${x},${y}`;
    })
    .join(" ");
}

function formatTime(value?: string) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function splitAssistantContent(content: string) {
  const normalized = String(content || "");
  const divider = "\n---\n";
  const dividerIndex = normalized.indexOf(divider);
  const body = dividerIndex >= 0 ? normalized.slice(0, dividerIndex).trim() : normalized.trim();
  const footer = dividerIndex >= 0 ? normalized.slice(dividerIndex + divider.length).trim() : "";
  const evidenceMatch = /(?:^|\n)(?:#{1,6}\s*)?(?:\*\*)?(关键依据|回答依据|证据|来源指针)(?:\*\*)?\s*[:：]?\s*/m.exec(normalized);
  if (evidenceMatch && evidenceMatch.index != null) {
    const index = evidenceMatch.index;
    const preview = normalized.slice(0, index).trim();
    const evidence = normalized.slice(index).trim();
    return {
      preview: preview || normalized,
      evidence,
    };
  }
  const compact = body.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (compact.length <= 180 && !footer) return { preview: normalized, evidence: "" };

  const firstBlock = body.split(/\n{2,}/).find((x) => String(x || "").trim()) || body;
  const firstSentence =
    firstBlock.split(/(?<=[。！？!?.])/)[0]?.trim() ||
    compact.slice(0, 120).trim() ||
    "已生成回答，请查看详情。";
  const preview = firstSentence.length > 140 ? `${firstSentence.slice(0, 140)}…` : firstSentence;
  const evidenceBody = [body, footer ? `---\n${footer}` : ""].filter(Boolean).join("\n\n").trim();
  return {
    preview,
    evidence: evidenceBody ? `关键依据:\n${evidenceBody}` : "",
  };
}

export default function ChatApp() {
  const { user } = useUser();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [highlightMessageId, setHighlightMessageId] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechInterim, setSpeechInterim] = useState("");
  const [voiceTarget, setVoiceTarget] = useState<"chat" | "diary-success" | "diary-money" | "diary-gaokao">("chat");
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<number | null>(null);
  const [raisedMessageId, setRaisedMessageId] = useState<number | null>(null);

  const [email, setEmail] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [autoWeb, setAutoWeb] = useState(true);
  const [memoryOnlyMode, setMemoryOnlyMode] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [autoMindmap, setAutoMindmap] = useState(true);
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [nvidiaKey, setNvidiaKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [tavilyKey, setTavilyKey] = useState("");
  const [openrouterModels, setOpenrouterModels] = useState<string[]>(["google/gemma-4-31b-it:free", "openai/gpt-oss-120b:free"]);
  const [nvidiaModels, setNvidiaModels] = useState<string[]>(["minimaxai/minimax-m2.7", "z-ai/glm-5.1"]);
  const [googleModels, setGoogleModels] = useState<string[]>(["gemini-2.5-flash"]);
  const [openrouterModelSwitches, setOpenrouterModelSwitches] = useState<Record<string, boolean>>({});
  const [nvidiaModelSwitches, setNvidiaModelSwitches] = useState<Record<string, boolean>>({});
  const [googleModelSwitches, setGoogleModelSwitches] = useState<Record<string, boolean>>({});
  const [newOpenrouterModel, setNewOpenrouterModel] = useState("");
  const [newNvidiaModel, setNewNvidiaModel] = useState("");
  const [newGoogleModel, setNewGoogleModel] = useState("");
  const [settingsNav, setSettingsNav] = useState("strategy");
  const [showAdmin, setShowAdmin] = useState(false);
  const [showCommandCenter, setShowCommandCenter] = useState(false);
  const [workbenchCollapsed, setWorkbenchCollapsed] = useState(true);
  const [mainView, setMainView] = useState<"chat" | "settings" | "quality" | "weekly" | "diary">("chat");
  const [resourceCollapsed, setResourceCollapsed] = useState(false);
  const [favoritesCollapsed, setFavoritesCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [qualityModelFilter, setQualityModelFilter] = useState("all");
  const [qualityTaskFilter, setQualityTaskFilter] = useState("all");
  const [qualityReview, setQualityReview] = useState<QualityReview | null>(null);
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport | null>(null);
  const [diaryDate, setDiaryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [successJournal, setSuccessJournal] = useState("");
  const [moneyJournal, setMoneyJournal] = useState("");
  const [gaokaoJournal, setGaokaoJournal] = useState("");
  const [diaryHistory, setDiaryHistory] = useState<
    Array<{ diary_date: string; success_journal: string; money_journal: string; gaokao_journal: string; updated_at: string; categories?: string[] }>
  >([]);

  const [usageToday, setUsageToday] = useState<UsageData>({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const [usageTotal, setUsageTotal] = useState<UsageData>({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const [quality, setQuality] = useState<QualityData>({ availability24h: 100, switchSuccess24h: 100 });

  const [memoryStats, setMemoryStats] = useState<{ total_files: number; total_lines: number; latest_memory_update: string | null }>({
    total_files: 0,
    total_lines: 0,
    latest_memory_update: null,
  });
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [memorySearchText, setMemorySearchText] = useState("");
  const [newMemoryTitle, setNewMemoryTitle] = useState("");
  const [newMemoryContent, setNewMemoryContent] = useState("");
  const [newMemoryStatus, setNewMemoryStatus] = useState<"valid" | "outdated">("valid");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryTitle, setEditingMemoryTitle] = useState("");
  const [editingMemoryContent, setEditingMemoryContent] = useState("");
  const [editingMemoryStatus, setEditingMemoryStatus] = useState<"valid" | "outdated">("valid");
  const [insightMessage, setInsightMessage] = useState<Message | null>(null);

  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: number; conversationId: string; title: string; snippet: string }>>([]);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);

  const [adminData, setAdminData] = useState<{
    stats?: { totalUsers: number; totalConversations: number; totalMessages: number; totalMemoryBackups?: number };
    users?: Array<{ user_id: string; email: string; total_tokens: number; conversations: number; messages: number; is_blocked?: boolean; blocked_reason?: string | null }>;
    conversations?: Array<{ id: string; user_id: string; email: string; title: string; updated_at: string; latest_message: string }>;
  }>({});
  const [changeLogs, setChangeLogs] = useState<ChangeLogItem[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [announcementDraft, setAnnouncementDraft] = useState("");
  const [hasEnteredWorkspace, setHasEnteredWorkspace] = useState(false);
  const [introInput, setIntroInput] = useState("");
  const [petNameDraft, setPetNameDraft] = useState("Mochi");
  const [pet, setPet] = useState<PetState>({
    species: "cat",
    name: "Mochi",
    mood: "idle",
    energy: 80,
    level: 1,
    xp: 0,
    xpToNext: 80,
    rarity: "rare",
    trait_focus: "wisdom",
    trait_weakness: "snark",
    attributes: { debugging: 55, patience: 50, chaos: 40, wisdom: 58, snark: 35 },
    emoji: "🐱",
    trait: "专注与独立",
  });

  const filteredMemoryEntries = useMemo(() => {
    const q = memorySearchText.trim().toLowerCase();
    if (!q) return memoryEntries;
    return memoryEntries.filter((entry) =>
      `${entry.title}\n${entry.content}\n${entry.source_pointer || ""}`.toLowerCase().includes(q),
    );
  }, [memoryEntries, memorySearchText]);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) || null,
    [conversations, activeConversationId],
  );
  const accountName = useMemo(() => {
    if (user?.fullName?.trim()) return user.fullName.trim();
    if (user?.username?.trim()) return user.username.trim();
    if (email?.includes("@")) return email.split("@")[0];
    return email || "当前用户";
  }, [user, email]);
  const petAverage = useMemo(() => {
    const attrs = pet.attributes;
    if (!attrs) return 0;
    const values = [attrs.debugging, attrs.patience, attrs.chaos, attrs.wisdom, attrs.snark].map((x) => Number(x || 0));
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }, [pet.attributes]);
  const petLevel = Math.max(1, Number(pet.level || 1));
  const petXp = Math.max(0, Number(pet.xp || 0));
  const petXpToNext = Math.max(1, Number(pet.xpToNext || 80));
  const petXpPercent = Math.max(0, Math.min(100, (petXp / petXpToNext) * 100));
  const petRarityClass = `rarity-${pet.rarity || "rare"}`;
  const diaryStatusSeries = useMemo(() => {
    const scoreText = (text: string) => {
      const t = String(text || "");
      let score = 50;
      if (/完成|做完|推进|进步|突破|顺利|成交|增长|拿下/.test(t)) score += 18;
      if (/计划|下一步|安排|目标|复盘|改进/.test(t)) score += 10;
      if (/焦虑|拖延|崩溃|失败|卡住|混乱|疲惫|压力/.test(t)) score -= 18;
      return Math.max(5, Math.min(95, score));
    };
    return [...diaryHistory]
      .slice(0, 14)
      .reverse()
      .map((d) => {
        const success = scoreText(d.success_journal || "");
        const money = scoreText(d.money_journal || "");
        const gaokao = scoreText(d.gaokao_journal || "");
        const score = Math.round((success + money + gaokao) / 3);
        return { day: String(d.diary_date || "").slice(5), score };
      });
  }, [diaryHistory]);
  const petTraitLabel: Record<string, string> = {
    debugging: "调试能力",
    patience: "耐心值",
    chaos: "混乱值",
    wisdom: "智慧值",
    snark: "毒舌值",
  };
  const petRarityLabel: Record<string, string> = {
    common: "普通",
    uncommon: "优秀",
    rare: "稀有",
    epic: "史诗",
    legendary: "传说",
  };
  const petMoodLabel: Record<string, string> = {
    thinking: "正在思考",
    happy: "刚答完，很开心",
    idle: "待命中",
    playful: "在玩耍",
    resting: "在休息",
    legendary: "全力护航",
  };
  const petActionText = sending
    ? `${pet.emoji || "🐱"} ${pet.name} 正在帮你分析问题`
    : `${pet.emoji || "🐱"} ${pet.name} ${petMoodLabel[pet.mood || "idle"] || "待命中"}`;
  const recognitionRef = useRef<null | { stop: () => void }>(null);
  const keepListeningRef = useRef(false);
  const speechFinalSnapshotRef = useRef("");
  const messagesContainerRef = useRef<HTMLElement | null>(null);
  const reminderTickingRef = useRef(false);
  const lastAssistantMessageIdRef = useRef<number>(0);
  const activeConversationIdRef = useRef<string | null>(null);
  const nightlyRollupDoneRef = useRef(false);

  const showToast = useCallback((next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const markdownComponents = useMemo<Components>(
    () => ({
      code(nodeProps) {
        const { inline, className, children, ...props } = nodeProps as {
          inline?: boolean;
          className?: string;
          children?: ReactNode;
          [key: string]: unknown;
        };
        const raw = String(children ?? "").replace(/\n$/, "");
        if (inline) {
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        }
        const language = className?.replace("language-", "") || "code";
        const lines = raw ? raw.split("\n") : [];
        const preview = lines.slice(0, 2).join(" ").slice(0, 120);
        return (
          <details className="code-fold" open={lines.length <= 14}>
            <summary className="code-fold-summary">
              <span className="code-lang">{language}</span>
              <span className="code-lines">{lines.length} 行</span>
              <span className="code-preview">{preview || "点击展开代码预览"}</span>
            </summary>
            <pre className={className}>
              <code {...props}>{raw}</code>
            </pre>
          </details>
        );
      },
    }),
    [],
  );
  const getKnowledgeRadar = useCallback((message: Message): RadarMetrics => {
    const confidence =
      message.confidence_level === "high" ? 88 : message.confidence_level === "low" ? 50 : 72;
    const sourceCount = Array.isArray(message.sources) ? message.sources.length : 0;
    const sourceCoverage = message.web_used ? Math.min(95, 42 + sourceCount * 18) : message.files_used ? 52 : 34;
    const timeliness = message.web_used ? Math.min(96, 72 + sourceCount * 6) : 56;
    const verifiability =
      Math.min(
        95,
        (message.web_used ? 46 : 20) + (message.files_used ? 24 : 0) + (sourceCount > 0 ? Math.min(30, sourceCount * 8) : 0),
      );
    const consistency = Math.min(
      96,
      Math.round((confidence * 0.35 + sourceCoverage * 0.2 + verifiability * 0.25 + timeliness * 0.2) * 100) / 100,
    );
    return { confidence, sourceCoverage, timeliness, verifiability, consistency };
  }, []);

  const playReplyTone = useCallback(() => {
    try {
      const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(740, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(920, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.26);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.27);
    } catch {
      // ignore
    }
  }, []);

  const showDesktopCard = useCallback(async (content: string) => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (document.visibilityState === "visible") return;
    if (Notification.permission === "default") {
      await Notification.requestPermission().catch(() => "denied");
    }
    if (Notification.permission !== "granted") return;
    const body = content.replace(/\s+/g, " ").slice(0, 130) || "你的新回答已生成";
    const note = new Notification("Crazy Agent 新回复", {
      body,
      icon: user?.imageUrl || "/assistant-avatar.jpg",
      tag: `reply-${Date.now()}`,
    });
    setTimeout(() => note.close(), 5000);
  }, [user?.imageUrl]);

  const interactPet = useCallback(async (action: "thinking" | "answered" | "idle" | "play" | "rest") => {
    try {
      const response = await fetch("/api/pet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data?.pet) {
        setPet((prev) => ({ ...prev, ...data.pet }));
      }
    } catch {
      // ignore
    }
  }, []);

  const cleanTranscript = useCallback((text: string) => {
    let value = text.replace(/\s+/g, " ").trim();
    value = value.replace(/([，。！？,.!?])/g, "$1 ");
    value = value.replace(/\s+/g, " ").trim();
    value = value.replace(/(.{2,20})\1{2,}/g, "$1");
    return value;
  }, []);

  const appendToInput = useCallback((prev: string, chunk: string) => {
    const c = cleanTranscript(chunk);
    if (!c) return prev;
    return `${prev}${prev ? " " : ""}${c}`;
  }, [cleanTranscript]);

  const loadBootstrap = useCallback(async () => {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();

    setEmail(data.profile?.email || "");
    setIsAdmin(Boolean(data.profile?.isAdmin));
    setSystemPrompt(data.settings?.system_prompt || "");
    setAutoWeb(data.settings?.auto_web ?? true);
    setMemoryOnlyMode(data.settings?.memory_only_mode ?? false);
    setVoiceEnabled(data.settings?.voice_enabled ?? true);
    setAutoMindmap(data.settings?.auto_mindmap ?? true);
    setOpenrouterKey(data.settings?.openrouter_key || "");
    setNvidiaKey(data.settings?.nvidia_key || "");
    setGoogleKey(data.settings?.google_key || "");
    setTavilyKey(data.settings?.tavily_key || "");
    const nextOpenrouterModels =
      Array.isArray(data.settings?.openrouter_models) && data.settings.openrouter_models.length
        ? data.settings.openrouter_models
        : ["google/gemma-4-31b-it:free", "openai/gpt-oss-120b:free"];
    const nextNvidiaModels =
      Array.isArray(data.settings?.nvidia_models) && data.settings.nvidia_models.length
        ? data.settings.nvidia_models
        : ["minimaxai/minimax-m2.7", "z-ai/glm-5.1"];
    const nextGoogleModels =
      Array.isArray(data.settings?.google_models) && data.settings.google_models.length
        ? data.settings.google_models
        : ["gemini-2.5-flash"];
    setOpenrouterModels(nextOpenrouterModels);
    setNvidiaModels(nextNvidiaModels);
    setGoogleModels(nextGoogleModels);
    const incomingOpenrouterSwitches =
      data.settings?.openrouter_model_switches && typeof data.settings.openrouter_model_switches === "object"
        ? (data.settings.openrouter_model_switches as Record<string, boolean>)
        : {};
    const incomingNvidiaSwitches =
      data.settings?.nvidia_model_switches && typeof data.settings.nvidia_model_switches === "object"
        ? (data.settings.nvidia_model_switches as Record<string, boolean>)
        : {};
    const incomingGoogleSwitches =
      data.settings?.google_model_switches && typeof data.settings.google_model_switches === "object"
        ? (data.settings.google_model_switches as Record<string, boolean>)
        : {};
    const normalizedOpenrouterSwitches: Record<string, boolean> = {};
    for (const model of nextOpenrouterModels) {
      normalizedOpenrouterSwitches[model] =
        Object.prototype.hasOwnProperty.call(incomingOpenrouterSwitches, model)
          ? Boolean(incomingOpenrouterSwitches[model])
          : true;
    }
    const normalizedNvidiaSwitches: Record<string, boolean> = {};
    for (const model of nextNvidiaModels) {
      normalizedNvidiaSwitches[model] =
        Object.prototype.hasOwnProperty.call(incomingNvidiaSwitches, model)
          ? Boolean(incomingNvidiaSwitches[model])
          : true;
    }
    const normalizedGoogleSwitches: Record<string, boolean> = {};
    for (const model of nextGoogleModels) {
      normalizedGoogleSwitches[model] =
        Object.prototype.hasOwnProperty.call(incomingGoogleSwitches, model)
          ? Boolean(incomingGoogleSwitches[model])
          : true;
    }
    setOpenrouterModelSwitches(normalizedOpenrouterSwitches);
    setNvidiaModelSwitches(normalizedNvidiaSwitches);
    setGoogleModelSwitches(normalizedGoogleSwitches);
    setUsageToday(data.usage?.today || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setUsageTotal(data.usage?.total || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setQuality(data.quality || { availability24h: 100, switchSuccess24h: 100 });
    setAnnouncement(data.announcement?.content || "");
    setAnnouncementDraft(data.announcement?.content || "");
    setPet((prev) => ({ ...prev, ...(data.pet || {}) }));
    setPetNameDraft(data.pet?.name || "Mochi");
  }, []);

  const loadConversations = useCallback(async () => {
    const response = await fetch("/api/conversations", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const list = data.conversations || [];
    setConversations((prev) => {
      if (!prev.length) return list;
      const prevMap = new Map(prev.map((item) => [item.id, item]));
      return list.map((item: Conversation) => {
        const old = prevMap.get(item.id);
        return old ? { ...old, ...item } : item;
      });
    });

    const currentActive = activeConversationIdRef.current;
    if (!currentActive && list[0]?.id) {
      setActiveConversationId(list[0].id);
      activeConversationIdRef.current = list[0].id;
    }
  }, []);

  const loadConversation = useCallback(async (conversationId: string) => {
    const response = await fetch(`/api/conversations/${conversationId}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setMessages(data.messages || []);
    requestAnimationFrame(() => {
      const el = messagesContainerRef.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
        setShowJumpBottom(false);
      }
    });
  }, []);

  const loadMemory = useCallback(async () => {
    const response = await fetch("/api/memory", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setMemoryStats(data.stats || { total_files: 0, total_lines: 0, latest_memory_update: null });
    setMemoryEntries(data.entries || []);
  }, []);

  const loadStats = useCallback(async () => {
    const response = await fetch("/api/stats", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setUsageToday(data.today || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setUsageTotal(data.total || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  }, []);

  const loadChangeLogs = useCallback(async () => {
    const response = await fetch("/api/changelog");
    if (!response.ok) return;
    const data = await response.json();
    setChangeLogs(data.logs || []);
  }, []);

  const loadPet = useCallback(async () => {
    const response = await fetch("/api/pet");
    if (!response.ok) return;
    const data = await response.json();
    if (data?.pet) {
      setPet((prev) => ({ ...prev, ...data.pet }));
      setPetNameDraft(data.pet?.name || "Mochi");
    }
  }, []);

  const loadQualityReview = useCallback(async (model = qualityModelFilter, taskType = qualityTaskFilter) => {
    const query = new URLSearchParams({ model, taskType }).toString();
    const response = await fetch(`/api/review/quality?${query}`);
    if (!response.ok) return;
    const data = await response.json();
    setQualityReview(data);
  }, [qualityModelFilter, qualityTaskFilter]);

  const loadWeeklyReport = useCallback(async () => {
    const response = await fetch("/api/reports/weekly");
    if (!response.ok) return;
    const data = await response.json();
    setWeeklyReport(data);
  }, []);

  const boot = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadBootstrap(), loadConversations(), loadMemory(), loadChangeLogs(), loadPet()]);
    setLoading(false);
  }, [loadBootstrap, loadConversations, loadMemory, loadChangeLogs, loadPet]);

  useEffect(() => {
    boot();
  }, [boot]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    const applyDaypartTheme = () => {
      const hour = new Date().getHours();
      let daypart: "morning" | "afternoon" | "night" = "morning";
      if (hour >= 12 && hour < 18) daypart = "afternoon";
      if (hour >= 18 || hour < 6) daypart = "night";
      document.body.setAttribute("data-daypart", daypart);
    };

    applyDaypartTheme();
    const timer = setInterval(applyDaypartTheme, 60 * 1000);
    return () => {
      clearInterval(timer);
      document.body.removeAttribute("data-daypart");
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowCommandCenter(true);
      }
      if (event.key === "Escape") {
        setShowCommandCenter(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/memory/sync", { method: "POST" }).catch(() => undefined);
  }, [isAdmin]);

  useEffect(() => {
    let disposed = false;

    const tickReminder = async () => {
      if (disposed) return;
      try {
        const response = await fetch("/api/reminder/trigger", { method: "POST" });
        if (!response.ok) return;
        const data = await response.json();
        if (data?.inserted) {
          await loadConversations();
          if (activeConversationId && String(data.conversationId) === String(activeConversationId)) {
            await loadConversation(activeConversationId);
          }
          showToast({ type: "success", text: "学习回顾提醒已送达" });
        }
      } catch {
        // noop
      }
    };

    void tickReminder();
    const timer = setInterval(() => {
      void tickReminder();
    }, 60 * 1000);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [activeConversationId, loadConversation, loadConversations, showToast]);

  useEffect(() => {
    const w = window as Window & {
      webkitSpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        continuous: boolean;
        start: () => void;
        stop: () => void;
        onresult: ((event: {
          resultIndex: number;
          results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
        }) => void) | null;
        onerror: ((event: { error: string }) => void) | null;
        onend: (() => void) | null;
      };
      SpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        continuous: boolean;
        start: () => void;
        stop: () => void;
        onresult: ((event: {
          resultIndex: number;
          results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
        }) => void) | null;
        onerror: ((event: { error: string }) => void) | null;
        onend: (() => void) | null;
      };
    };

    setSpeechSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    return () => {
      keepListeningRef.current = false;
      recognitionRef.current?.stop();
      setSpeechInterim("");
    };
  }, []);

  useEffect(() => {
    voiceService.init();
    voiceService.setEnabled(voiceEnabled);
  }, [voiceEnabled]);

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      setSelectedFiles([]);
      return;
    }
    setSelectedFiles([]);
    loadConversation(activeConversationId);
  }, [activeConversationId, loadConversation]);

  useEffect(() => {
    if (!hasEnteredWorkspace) return;
    if (!qualityReview) {
      void loadQualityReview("all", "all");
    }
    if (!weeklyReport) {
      void loadWeeklyReport();
    }
  }, [hasEnteredWorkspace, loadQualityReview, loadWeeklyReport, qualityReview, weeklyReport]);

  useEffect(() => {
    if (messages.length > 0 && !workbenchCollapsed) {
      setWorkbenchCollapsed(true);
    }
  }, [messages.length, workbenchCollapsed]);

  useEffect(() => {
    if (mainView !== "diary") return;
    loadDiaryHistory();
  }, [mainView]);

  useEffect(() => {
    if (mainView !== "diary") return;
    loadDiaryEntry(diaryDate);
  }, [mainView, diaryDate]);

  useEffect(() => {
    if (mainView !== "settings") return;
    setSettingsNav("strategy");
  }, [mainView]);

  const tickStudyReminder = useCallback(async () => {
    if (reminderTickingRef.current) return;
    reminderTickingRef.current = true;
    try {
      const qs = activeConversationId ? `?conversationId=${encodeURIComponent(activeConversationId)}` : "";
      const response = await fetch(`/api/reminders/tick${qs}`, { method: "POST" });
      if (!response.ok) return;
      const data = await response.json();
      if (!data?.created) return;
      showToast({ type: "success", text: "学习复盘提醒已发送：过去2小时你学到了什么？" });
      await loadConversations();
      const conversationId = String(data.conversationId || "");
      if (conversationId) {
        if (conversationId !== activeConversationId) {
          setActiveConversationId(conversationId);
        }
        await loadConversation(conversationId);
      }
    } catch {
      // ignore reminder transient errors
    } finally {
      reminderTickingRef.current = false;
    }
  }, [activeConversationId, loadConversation, loadConversations, showToast]);

  const triggerNightlyRollup = useCallback(
    async (force = false) => {
      if (nightlyRollupDoneRef.current && !force) return;
      const now = new Date();
      const hour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).format(now),
      );
      if (!force && hour < 21) return;
      try {
        const response = await fetch("/api/memory/nightly-rollup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        });
        if (!response.ok) return;
        const data = await response.json();
        if (data?.skipped === "already-rolled") {
          nightlyRollupDoneRef.current = true;
          return;
        }
        if (data?.ok && !data?.skipped) {
          nightlyRollupDoneRef.current = true;
          await loadMemory();
          showToast({ type: "success", text: "今晚讨论已自动整理进长期记忆" });
        }
      } catch {
        // ignore
      }
    },
    [loadMemory, showToast],
  );

  useEffect(() => {
    tickStudyReminder();
    const timer = setInterval(() => {
      tickStudyReminder();
    }, 60_000);
    return () => clearInterval(timer);
  }, [tickStudyReminder]);

  useEffect(() => {
    if (!hasEnteredWorkspace) return;
    void triggerNightlyRollup(false);
    const timer = setInterval(() => {
      void triggerNightlyRollup(false);
    }, 5 * 60_000);
    return () => clearInterval(timer);
  }, [hasEnteredWorkspace, triggerNightlyRollup]);

  const createConversation = async (firstMessage = "") => {
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstMessage }),
    });

    if (!response.ok) {
      throw new Error("新建对话失败");
    }

    const data = await response.json();
    const newConversation = data.conversation as Conversation | undefined;

    if (!newConversation?.id) {
      throw new Error("新建对话失败");
    }

    // 避免每次新建后整列表重新拉取导致整页闪动
    setConversations((prev) => [newConversation, ...prev.filter((x) => x.id !== newConversation.id)]);
    setActiveConversationId(newConversation.id);
    setMessages([]);
    setSelectedFiles([]);

    return newConversation.id;
  };

  const patchConversationPreview = (conversationId: string, latestMessage: string) => {
    setConversations((prev) => {
      const hit = prev.find((c) => c.id === conversationId);
      const updated: Conversation = hit
        ? { ...hit, latest_message: latestMessage, updated_at: new Date().toISOString() }
        : { id: conversationId, title: "新对话", latest_message: latestMessage, updated_at: new Date().toISOString() };
      return [updated, ...prev.filter((c) => c.id !== conversationId)];
    });
  };

  const sendMessage = async (overrideText?: string) => {
    const text = typeof overrideText === "string" ? overrideText.trim() : input.trim();
    const hasFiles = selectedFiles.length > 0;
    if ((!text && !hasFiles) || sending) return;
    const effectiveText = text || "请先识别并总结我上传的图片/文件，再回答。";
    setSending(true);
    interactPet("thinking");
    const now = new Date().toISOString();
    const optimisticUserId = -Date.now();
    const optimisticAssistantId = optimisticUserId - 1;

    setMessages((prev) => [
      ...prev,
      { id: optimisticUserId, role: "user", content: effectiveText, created_at: now },
      { id: optimisticAssistantId, role: "assistant", content: "正在思考中...", created_at: now },
    ]);
    let conversationId: string | null = activeConversationId;

    try {
      if (!conversationId) {
        conversationId = await createConversation(effectiveText);
      }

      let fileIds: string[] = [];
      if (selectedFiles.length > 0) {
        const formData = new FormData();
        formData.append("conversationId", conversationId);
        selectedFiles.forEach((file) => formData.append("files", file));

        const uploadResponse = await fetch("/api/files/upload", { method: "POST", body: formData });
        if (!uploadResponse.ok) {
          const data = await uploadResponse.json().catch(() => ({}));
          throw new Error(data.error || "文件上传失败");
        }

        const uploadData = await uploadResponse.json();
        fileIds = (uploadData.files || []).map((item: { id: string }) => item.id);
        if (!fileIds.length) {
          throw new Error("文件已提交但未入库，请重试");
        }
        showToast({ type: "success", text: `已上传 ${fileIds.length} 个文件，正在识别内容...` });
      }

      setInput("");
      setSelectedFiles([]);

      const requestController = new AbortController();
      const requestTimer = setTimeout(() => requestController.abort("request-timeout"), 90_000);
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: effectiveText, fileIds, stream: true }),
        signal: requestController.signal,
      }).finally(() => clearTimeout(requestTimer));

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "发送失败");
      }

      const contentType = response.headers.get("content-type") || "";
      let beginPayload: {
        userMessageId?: number;
        assistantMessageId?: number;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingSeconds?: number;
        webUsed?: boolean;
        filesUsed?: boolean;
        confidenceLevel?: string;
        mindmapUrl?: string | null;
        mindmapPrompt?: string | null;
        sources?: Array<{ title: string; url: string; snippet: string }>;
      } | null = null;
      if (contentType.includes("text/event-stream") && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamed = "";
        let lastChunkAt = Date.now();

        const applyAssistantText = (text: string) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === optimisticAssistantId
                ? {
                    ...m,
                    content: text || "正在思考中...",
                    model_provider: beginPayload?.modelProvider || m.model_provider || null,
                    model_id: beginPayload?.modelId || m.model_id || null,
                    web_used: beginPayload?.webUsed ?? m.web_used ?? false,
                    files_used: beginPayload?.filesUsed ?? m.files_used ?? false,
                    confidence_level: beginPayload?.confidenceLevel || m.confidence_level || "medium",
                    sources: beginPayload?.sources || m.sources || [],
                    mindmap_url: beginPayload?.mindmapUrl || m.mindmap_url || null,
                    mindmap_prompt: beginPayload?.mindmapPrompt || m.mindmap_prompt || null,
                  }
                : m,
            ),
          );
        };

        while (true) {
          const { done, value } = await reader.read();
          if (Date.now() - lastChunkAt > 45_000) {
            try {
              await reader.cancel("stream-idle-timeout");
            } catch {
              // ignore
            }
            throw new Error("响应超时：模型长时间无返回");
          }
          if (value) {
            lastChunkAt = Date.now();
            buffer += decoder.decode(value, { stream: !done });
          }
          const events = buffer.split(/\n\n/);
          buffer = events.pop() || "";

          for (const event of events.filter(Boolean)) {
            const line = event.trim();
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            const payload = JSON.parse(raw) as
              | {
                  type: "begin";
                  payload: {
                    content?: string;
                    userMessageId?: number;
                    assistantMessageId?: number;
                    modelProvider?: string | null;
                    modelId?: string | null;
                    thinkingSeconds?: number;
                    webUsed?: boolean;
                    filesUsed?: boolean;
                    confidenceLevel?: string;
                    mindmapUrl?: string | null;
                    mindmapPrompt?: string | null;
                    sources?: Array<{ title: string; url: string; snippet: string }>;
                  };
                }
              | { type: "delta"; delta: string }
              | { type: "done" };

            if (payload.type === "begin") {
              beginPayload = payload.payload || null;
              streamed = payload.payload.content || "";
              applyAssistantText(streamed);
              continue;
            }
            if (payload.type === "delta") {
              streamed += payload.delta || "";
              applyAssistantText(streamed);
            }
          }
          if (done) break;
        }

        const tail = buffer.trim();
        if (tail.startsWith("data:")) {
          const raw = tail.slice(5).trim();
          if (raw) {
            const payload = JSON.parse(raw) as { type: "delta"; delta?: string } | { type: "done" };
            if (payload.type === "delta") {
              streamed += payload.delta || "";
              applyAssistantText(streamed);
            }
          }
        }
      }

      if (beginPayload?.assistantMessageId || beginPayload?.userMessageId) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === optimisticUserId && beginPayload?.userMessageId) {
              return { ...m, id: beginPayload.userMessageId };
            }
            if (m.id === optimisticAssistantId && beginPayload?.assistantMessageId) {
              return {
                ...m,
                id: beginPayload.assistantMessageId,
                model_provider: beginPayload.modelProvider || m.model_provider || null,
                model_id: beginPayload.modelId || m.model_id || null,
                web_used: beginPayload.webUsed ?? m.web_used ?? false,
                files_used: beginPayload.filesUsed ?? m.files_used ?? false,
                confidence_level: beginPayload.confidenceLevel || m.confidence_level || "medium",
                sources: beginPayload.sources || m.sources || [],
                mindmap_url: beginPayload.mindmapUrl || m.mindmap_url || null,
                mindmap_prompt: beginPayload.mindmapPrompt || m.mindmap_prompt || null,
              };
            }
            return m;
          }),
        );
      }

      patchConversationPreview(conversationId, effectiveText);
      await Promise.all([loadConversation(conversationId), loadStats(), loadMemory()]);
      void loadConversations();
      interactPet("answered");
    } catch (error) {
      const safeConversationId = activeConversationIdRef.current || conversationId;
      if (safeConversationId) {
        await loadConversation(safeConversationId);
      }
      setMessages((prev) => {
        const hasServerAnswer = prev.some((m) => m.role === "assistant" && typeof m.id === "number" && m.id > 0);
        if (hasServerAnswer) return prev;
        return prev.filter((m) => m.id !== optimisticUserId && m.id !== optimisticAssistantId);
      });
      showToast({ type: "error", text: String(error) || "请求超时，已尝试自动恢复最新消息" });
      interactPet("idle");
    } finally {
      setSending(false);
    }
  };

  const copyAnswer = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast({ type: "success", text: "答案已复制" });
    } catch {
      showToast({ type: "error", text: "复制失败，请检查浏览器权限" });
    }
  };

  const regenerateAnswer = async (assistantMessageId: number) => {
    if (!activeConversationId || regeneratingMessageId || sending) return;
    setRegeneratingMessageId(assistantMessageId);
    try {
      const response = await fetch(`/api/conversations/${activeConversationId}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantMessageId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "重生成失败");
      }
      await Promise.all([loadConversation(activeConversationId), loadConversations(), loadStats(), loadMemory()]);
      showToast({ type: "success", text: "已重生成回答" });
    } catch (error) {
      showToast({ type: "error", text: String(error) });
    } finally {
      setRegeneratingMessageId(null);
    }
  };

  const removeConversation = async (conversationId: string) => {
    if (deletingConversationId === conversationId) return;
    setDeletingConversationId(conversationId);
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        showToast({ type: "error", text: data.error || "删除失败" });
        return;
      }

      setConversations((prev) => {
        const nextList = prev.filter((item) => item.id !== conversationId);
        if (activeConversationIdRef.current === conversationId) {
          const nextId = nextList[0]?.id || null;
          setActiveConversationId(nextId);
          activeConversationIdRef.current = nextId;
          if (!nextId) setMessages([]);
        }
        return nextList;
      });
      showToast({ type: "success", text: "对话已删除" });
    } finally {
      setDeletingConversationId(null);
    }
  };

  const toggleFavoriteConversation = async (conversationId: string) => {
    const response = await fetch(`/api/conversations/${conversationId}/favorite`, { method: "POST" });
    if (!response.ok) {
      showToast({ type: "error", text: "收藏切换失败" });
      return;
    }
    await loadConversations();
  };

  const saveSettings = async (payload?: Record<string, unknown>, successText = "设置保存成功") => {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        payload || {
          systemPrompt,
          autoWeb,
          memoryOnlyMode,
          voiceEnabled,
          autoMindmap,
          openrouterKey,
          nvidiaKey,
          googleKey,
          tavilyKey,
          openrouterModels,
          nvidiaModels,
          googleModels,
          openrouterModelSwitches,
          nvidiaModelSwitches,
          googleModelSwitches,
        },
      ),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast({ type: "error", text: data.error || "保存失败" });
      return;
    }

    await loadBootstrap();
    showToast({ type: "success", text: successText });
  };

  const savePetProfile = async () => {
    const name = petNameDraft.trim();
    if (!name) {
      showToast({ type: "error", text: "宠物名称不能为空" });
      return;
    }
    const response = await fetch("/api/pet", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast({ type: "error", text: data.error || "宠物保存失败" });
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (data?.pet) {
      setPet((prev) => ({ ...prev, ...data.pet }));
      setPetNameDraft(data.pet.name || name);
    }
    showToast({ type: "success", text: "宠物档案已保存" });
  };

  const saveAnnouncement = async () => {
    if (!isAdmin) return;
    const response = await fetch("/api/announcement", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: announcementDraft }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast({ type: "error", text: data.error || "公告保存失败" });
      return;
    }
    setAnnouncement(announcementDraft);
    showToast({ type: "success", text: "公告已更新" });
  };

  const syncAdminMemories = async () => {
    if (!isAdmin) return;
    const response = await fetch("/api/admin/memory/sync", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast({ type: "error", text: data.error || "导入失败" });
      return;
    }
    await loadMemory();
    showToast({ type: "success", text: `导入完成：新增 ${data.synced || 0} 条，跳过 ${data.skipped || 0} 条` });
  };

  const recoverAccountData = async () => {
    const response = await fetch("/api/account/recover", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast({ type: "error", text: data.error || "恢复失败" });
      return;
    }
    await Promise.all([loadBootstrap(), loadConversations(), loadMemory()]);
    showToast({
      type: "success",
      text: `数据恢复完成：合并 ${data.merged || 0} 个旧账号，补写 ${data.restoredMemories || 0} 条记忆`,
    });
  };

  const importAllDataToCodexMemory = async () => {
    const response = await fetch("/api/account/import-codex-memory", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast({ type: "error", text: data.error || "导入到 Codex 记忆失败" });
      return;
    }
    if (typeof data.memoryText === "string" && data.memoryText.trim()) {
      try {
        await navigator.clipboard.writeText(data.memoryText);
      } catch {
        // ignore clipboard failures
      }
    }
    showToast({ type: "success", text: data.message || "已导入到 Codex 记忆文件" });
  };

  const loadDiaryEntry = async (date: string) => {
    const response = await fetch(`/api/diary?date=${encodeURIComponent(date)}`);
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    const entry = data.entry;
    setSuccessJournal(entry?.success_journal || "");
    setMoneyJournal(entry?.money_journal || "");
    setGaokaoJournal(entry?.gaokao_journal || "");
  };

  const loadDiaryHistory = async () => {
    const response = await fetch("/api/diary");
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    setDiaryHistory(Array.isArray(data.categorized) ? data.categorized : Array.isArray(data.entries) ? data.entries : []);
  };

  const saveDiary = async (section: "all" | "success" | "money" | "gaokao" = "all") => {
    const response = await fetch("/api/diary", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        diaryDate,
        section,
        ...(section === "all" || section === "success" ? { successJournal } : {}),
        ...(section === "all" || section === "money" ? { moneyJournal } : {}),
        ...(section === "all" || section === "gaokao" ? { gaokaoJournal } : {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast({ type: "error", text: data.error || "日记保存失败" });
      return;
    }
    await Promise.all([loadDiaryHistory(), loadMemory(), loadDiaryEntry(diaryDate)]);
    if (data.memorySynced === false) {
      showToast({ type: "success", text: "日记已保存（长期记忆同步稍后自动补写）" });
      return;
    }
    showToast({
      type: "success",
      text:
        section === "all"
          ? "今日日记已保存"
          : section === "success"
            ? "成功日记已保存"
            : section === "money"
              ? "赚钱日记已保存"
              : "高考日记已保存",
    });
  };

  const addMemory = async () => {
    const title = newMemoryTitle.trim();
    const content = newMemoryContent.trim();
    if (!title || !content) {
      showToast({ type: "error", text: "记忆标题和内容不能为空" });
      return;
    }

    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        content,
        entryType: "note",
        status: newMemoryStatus,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast({ type: "error", text: data.error || "新增记忆失败" });
      return;
    }
    const data = await response.json().catch(() => ({}));

    setNewMemoryTitle("");
    setNewMemoryContent("");
    setNewMemoryStatus("valid");
    await loadMemory();
    showToast({ type: "success", text: data?.deduped ? "相同记忆已存在，未重复保存" : "长期记忆已新增" });
  };

  const startEditMemory = (entry: MemoryEntry) => {
    setEditingMemoryId(entry.id);
    setEditingMemoryTitle(entry.title);
    setEditingMemoryContent(entry.content);
    setEditingMemoryStatus((entry.status as "valid" | "outdated") || "valid");
  };

  const cancelEditMemory = () => {
    setEditingMemoryId(null);
    setEditingMemoryTitle("");
    setEditingMemoryContent("");
    setEditingMemoryStatus("valid");
  };

  const saveEditMemory = async () => {
    if (!editingMemoryId) return;
    if (!editingMemoryTitle.trim() || !editingMemoryContent.trim()) {
      showToast({ type: "error", text: "修改内容不能为空" });
      return;
    }

    const response = await fetch("/api/memory", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editingMemoryId, title: editingMemoryTitle, content: editingMemoryContent, status: editingMemoryStatus }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast({ type: "error", text: data.error || "修改记忆失败" });
      return;
    }

    cancelEditMemory();
    await loadMemory();
    showToast({ type: "success", text: "长期记忆已修改" });
  };

  const deleteMemory = async (id: string) => {
    if (deletingMemoryId === id) return;
    setDeletingMemoryId(id);
    const response = await fetch(`/api/memory?id=${encodeURIComponent(id)}`, { method: "DELETE" });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast({ type: "error", text: data.error || "删除记忆失败" });
      setDeletingMemoryId(null);
      return;
    }

    if (editingMemoryId === id) {
      cancelEditMemory();
    }
    await loadMemory();
    showToast({ type: "success", text: "长期记忆已删除" });
    setDeletingMemoryId(null);
  };

  const sendFeedback = async (messageId: number, feedback: "up" | "down") => {
    const response = await fetch(`/api/messages/${messageId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast({ type: "error", text: data.error || "反馈失败" });
      return;
    }
    if (activeConversationId) {
      await loadConversation(activeConversationId);
    }
    showToast({ type: "success", text: data.hint || "已记录偏好" });
  };

  const runSearch = async (q: string) => {
    setSearchText(q);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }

    const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!response.ok) {
      showToast({ type: "error", text: "搜索失败" });
      return;
    }

    const data = await response.json();
    setSearchResults(data.messages || []);
  };

  const renderHighlighted = useCallback((text: string, query: string) => {
    const q = query.trim();
    if (!q) return text;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reg = new RegExp(`(${escaped})`, "ig");
    const parts = text.split(reg);
    return parts.map((part, index): ReactNode => {
      if (part.toLowerCase() === q.toLowerCase()) {
        return (
          <mark
            key={`${part}-${index}`}
            style={{ background: "rgba(255, 236, 153, 0.36)", color: "#fff7cf", borderRadius: 4, padding: "0 2px" }}
          >
            {part}
          </mark>
        );
      }
      return <span key={`${part}-${index}`}>{part}</span>;
    });
  }, []);

  const jumpToHit = async (conversationId: string, messageId: number) => {
    setActiveConversationId(conversationId);
    await loadConversation(conversationId);
    setHighlightMessageId(messageId);
    setSearchText("");
    setSearchResults([]);
  };

  const enterWorkspace = async () => {
    const text = introInput.trim();
    setHasEnteredWorkspace(true);
    if (!text) return;
    setInput(text);
    setIntroInput("");
    await sendMessage(text);
  };

  const loadAdmin = async () => {
    const response = await fetch("/api/admin/dashboard");
    if (!response.ok) {
      showToast({ type: "error", text: "你不是管理员账号" });
      return;
    }

    const data = await response.json();
    setAdminData(data);
    if (typeof data?.announcement?.content === "string") {
      setAnnouncementDraft(data.announcement.content);
    }
  };

  const toggleUserBlock = async (targetUserId: string, blocked: boolean, reason = "") => {
    const response = await fetch("/api/admin/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId, blocked, reason }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast({ type: "error", text: data.error || "操作失败" });
      return;
    }
    await loadAdmin();
    showToast({ type: "success", text: blocked ? "用户已屏蔽" : "用户已解除屏蔽" });
  };

  const jumpSettingsSection = useCallback((id: string) => {
    setSettingsNav(id);
    const target = document.getElementById(`settings-${id}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const updateScrollState = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpBottom(gap > 120);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setShowJumpBottom(false);
  }, []);

  const startVoiceInput = useCallback((target: "chat" | "diary-success" | "diary-money" | "diary-gaokao" = "chat") => {
    const w = window as Window & {
      webkitSpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        continuous: boolean;
        start: () => void;
        stop: () => void;
        onresult: ((event: {
          resultIndex: number;
          results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
        }) => void) | null;
        onerror: ((event: { error: string }) => void) | null;
        onend: (() => void) | null;
      };
      SpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        continuous: boolean;
        start: () => void;
        stop: () => void;
        onresult: ((event: {
          resultIndex: number;
          results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
        }) => void) | null;
        onerror: ((event: { error: string }) => void) | null;
        onend: (() => void) | null;
      };
    };

    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      showToast({ type: "error", text: "当前浏览器不支持语音输入" });
      return;
    }

    keepListeningRef.current = true;
    setVoiceTarget(target);
    speechFinalSnapshotRef.current = "";
    setSpeechInterim("");
    const recognition = new Ctor();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let allFinal = "";
      let interim = "";

      for (let i = 0; i < event.results.length; i += 1) {
        const chunk = cleanTranscript(event.results[i]?.[0]?.transcript || "");
        if (!chunk) continue;
        if (event.results[i]?.isFinal) {
          allFinal += chunk;
        } else {
          interim += chunk;
        }
      }

      let delta = allFinal;
      if (allFinal.startsWith(speechFinalSnapshotRef.current)) {
        delta = allFinal.slice(speechFinalSnapshotRef.current.length);
      } else if (speechFinalSnapshotRef.current.startsWith(allFinal)) {
        delta = "";
      }
      speechFinalSnapshotRef.current = allFinal;

      if (delta.trim()) {
        if (target === "diary-success") {
          setSuccessJournal((prev) => appendToInput(prev, delta));
        } else if (target === "diary-money") {
          setMoneyJournal((prev) => appendToInput(prev, delta));
        } else if (target === "diary-gaokao") {
          setGaokaoJournal((prev) => appendToInput(prev, delta));
        } else {
          setInput((prev) => appendToInput(prev, delta));
        }
      }

      setSpeechInterim(cleanTranscript(interim));
    };

    recognition.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") {
        showToast({ type: "error", text: `语音输入异常: ${event.error}` });
      }
    };

    recognition.onend = () => {
      if (keepListeningRef.current) {
        try {
          recognition.start();
        } catch {
          setTimeout(() => {
            if (keepListeningRef.current) {
              try {
                recognition.start();
              } catch {
                keepListeningRef.current = false;
                setIsListening(false);
                setSpeechInterim("");
              }
            }
          }, 300);
        }
      } else {
        setIsListening(false);
        setSpeechInterim("");
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
      const targetLabel =
        target === "diary-success"
          ? "成功日记"
          : target === "diary-money"
          ? "赚钱日记"
          : target === "diary-gaokao"
          ? "高考日记"
          : "对话输入";
      showToast({ type: "success", text: `语音输入已开始（${targetLabel}），可持续说话，点一次按钮可停止` });
    } catch {
      keepListeningRef.current = false;
      setIsListening(false);
      showToast({ type: "error", text: "语音输入启动失败" });
    }
  }, [keepListeningRef, recognitionRef, showToast]);

  const stopVoiceInput = useCallback(() => {
    keepListeningRef.current = false;
    recognitionRef.current?.stop();
    setIsListening(false);
    setSpeechInterim("");
    showToast({ type: "success", text: "语音输入已停止" });
  }, [showToast]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (nearBottom) {
      scrollToBottom(false);
    } else {
      updateScrollState();
    }
  }, [messages, scrollToBottom, updateScrollState]);

  useEffect(() => {
    const assistantMessages = messages.filter((m) => m.role === "assistant" && typeof m.id === "number" && m.id > 0);
    if (!assistantMessages.length) return;
    const latest = assistantMessages[assistantMessages.length - 1];
    const latestId = Number(latest.id);
    if (!latestId || latestId <= lastAssistantMessageIdRef.current) return;
    lastAssistantMessageIdRef.current = latestId;
    setRaisedMessageId(latestId);
    setTimeout(() => setRaisedMessageId((prev) => (prev === latestId ? null : prev)), 1200);
    playReplyTone();
    showDesktopCard(latest.content);
  }, [messages, playReplyTone, showDesktopCard]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const visibleConversationItems =
    searchResults.length > 0
      ? searchResults.map((item) => ({
          id: `hit-${item.id}`,
          title: item.title,
          updated_at: "",
          latest_message: item.snippet,
          hitId: item.id,
          conversationId: item.conversationId,
        }))
      : conversations;
  const favoriteConversations = conversations.filter((item) => item.is_favorite);

  return (
    <div className="app-shell">
      <aside className="sidebar card">
        <div className="sidebar-profile card">
          <div className="brand-mini">Crazy Agent</div>
          <div className="brand-main-row">
            <div className="brand-main">Crazy Agent</div>
            <div className="brand-dot" />
          </div>
          <div className="account-row">
            <div className="account-name">{accountName}</div>
            <div className="account-email">{email || "当前账号"}</div>
          </div>
        </div>

        <VoiceButton
          className="btn new-chat-btn"
          voiceText="新对话已开启，开始记录吧"
          onClick={() => {
            setHasEnteredWorkspace(true);
            void createConversation().catch((error) => showToast({ type: "error", text: String(error) }));
          }}
        >
          <Plus size={18} /> 新建对话
        </VoiceButton>

        <div className="search-wrap">
          <Search size={16} className="search-icon" />
          <input className="input search-input" placeholder="按关键词直接跳到对话" value={searchText} onChange={(e) => runSearch(e.target.value)} />
        </div>

        <div className="conversation-list card scroll-y">
          <VoiceButton className="group-toggle" onClick={() => setResourceCollapsed((v) => !v)}>
            <span>对话记录</span>
            <span>{resourceCollapsed ? "▸" : "▾"}</span>
          </VoiceButton>

          {!resourceCollapsed ? (
            <>
              <VoiceButton className="subgroup-toggle" onClick={() => setFavoritesCollapsed((v) => !v)}>
                <span>置顶收藏 ({favoriteConversations.length})</span>
                <span>{favoritesCollapsed ? "▸" : "▾"}</span>
              </VoiceButton>
              {!favoritesCollapsed ? (
                <>
                  {favoriteConversations.length === 0 ? (
                    <div className="group-empty">暂无置顶收藏</div>
                  ) : null}
                  {favoriteConversations.map((item) => (
                    <div key={`fav-${item.id}`} className={`card convo-item ${activeConversationId === item.id ? "active" : ""}`}>
                      <VoiceButton className="btn secondary convo-open-btn" onClick={() => { setHasEnteredWorkspace(true); setActiveConversationId(item.id); }}>
                        <div className="convo-title">★ {item.title}</div>
                        <div className="convo-subtitle">{item.latest_message || formatTime(item.updated_at)}</div>
                      </VoiceButton>
                    </div>
                  ))}
                </>
              ) : null}

              <VoiceButton className="subgroup-toggle" onClick={() => setHistoryCollapsed((v) => !v)}>
                <span>全部对话 ({visibleConversationItems.length})</span>
                <span>{historyCollapsed ? "▸" : "▾"}</span>
              </VoiceButton>
              {!historyCollapsed ? (
                <>
                  {visibleConversationItems.map((item: Conversation & { hitId?: number; conversationId?: string }) => (
                    <div key={item.id} className={`card convo-item ${activeConversationId === (item.conversationId || item.id) ? "active" : ""}`}>
                      <VoiceButton
                        className="btn secondary convo-open-btn"
                        onClick={() => {
                          setHasEnteredWorkspace(true);
                          if (item.hitId && item.conversationId) jumpToHit(item.conversationId, item.hitId);
                          else setActiveConversationId(item.id);
                        }}
                      >
                        <div className="convo-title">{item.title}</div>
                        <div className="convo-subtitle">{item.latest_message || formatTime(item.updated_at)}</div>
                      </VoiceButton>
                      {!item.hitId ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <VoiceButton className="btn secondary full-width" onClick={() => toggleFavoriteConversation(item.id)}>
                            {item.is_favorite ? "取消置顶" : "置顶收藏"}
                          </VoiceButton>
                          <VoiceButton className="btn danger full-width" onClick={() => removeConversation(item.id)} disabled={deletingConversationId === item.id}>
                            <Trash2 size={14} /> {deletingConversationId === item.id ? "删除中..." : "删除"}
                          </VoiceButton>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="sidebar-bottom card">
          <VoiceButton className="btn secondary action-btn" voiceText="日记专栏已打开" onClick={() => { setMainView("diary"); }}>
            <Pencil size={16} /> 日记专栏
          </VoiceButton>
          <VoiceButton className="btn secondary action-btn" voiceText="设置页面已打开" onClick={() => { setMainView("settings"); }}>
            <Settings size={16} /> 设置
          </VoiceButton>
          <div className="account-entry">
            <div className="account-entry-label">我的账号</div>
            <UserButton />
          </div>
          <SignOutButton><VoiceButton className="btn secondary action-btn" voiceText="下次见，祝你顺利">退出</VoiceButton></SignOutButton>
        </div>
      </aside>

      <main className="main-panel">
        {mainView === "settings" ? (
          <div className="chat-frame card page-view">
            <header className="chat-header">
              <div className="chat-title-wrap">
                <div className="chat-title">Settings</div>
                <div className="chat-subtitle">统一管理模型、记忆、宠物与账号统计</div>
              </div>
              <VoiceButton className="btn secondary" onClick={() => setMainView("chat")}>返回对话</VoiceButton>
            </header>
            <section className="chat-messages scroll-y">
              <div className="settings-layout" style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 12, alignItems: "start" }}>
                <div className="card settings-panel settings-nav" style={{ padding: 10, position: "sticky", top: 0, display: "grid", gap: 8 }}>
                  {[
                    { id: "strategy", label: "策略与密钥" },
                    { id: "models", label: "模型ID管理" },
                    { id: "account", label: "账号与宠物" },
                    { id: "memory", label: "长期记忆" },
                    { id: "changelog", label: "更新日志" },
                  ].map((item) => (
                    <VoiceButton
                      key={item.id}
                      className={`btn secondary ${settingsNav === item.id ? "active" : ""}`}
                      onClick={() => jumpSettingsSection(item.id)}
                    >
                      {item.label}
                    </VoiceButton>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
                  <div id="settings-strategy" className="card settings-panel" style={{ padding: 12, display: "grid", gap: 10 }}>
                    <h4 style={{ margin: 0 }}>策略与模型配置</h4>
                    <div className="settings-section-title">系统长期要求</div>
                    <textarea className="input" style={{ minHeight: 120 }} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#c6d7ef" }}>
                        <input type="checkbox" checked={autoWeb} onChange={(e) => setAutoWeb(e.target.checked)} /> 自动判断是否联网
                      </label>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#c6d7ef" }}>
                        <input type="checkbox" checked={memoryOnlyMode} onChange={(e) => setMemoryOnlyMode(e.target.checked)} /> 日记记忆优先模式
                      </label>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#c6d7ef" }}>
                        <input type="checkbox" checked={voiceEnabled} onChange={(e) => setVoiceEnabled(e.target.checked)} /> 启用甜美女声按钮播报
                      </label>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#c6d7ef" }}>
                        <input type="checkbox" checked={autoMindmap} onChange={(e) => setAutoMindmap(e.target.checked)} /> 自动生成思维导图
                      </label>
                    </div>
                    <div className="settings-section-title">模型与联网密钥</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8 }}>
                      <input className="input" placeholder="OpenRouter API Key" value={openrouterKey} onChange={(e) => setOpenrouterKey(e.target.value)} />
                      <input className="input" placeholder="NVIDIA API Key" value={nvidiaKey} onChange={(e) => setNvidiaKey(e.target.value)} />
                      <input className="input" placeholder="Google AI Studio API Key" value={googleKey} onChange={(e) => setGoogleKey(e.target.value)} />
                      <input className="input" placeholder="Tavily API Key" value={tavilyKey} onChange={(e) => setTavilyKey(e.target.value)} />
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <VoiceButton
                        className="btn"
                        voiceText="策略设置已保存"
                        onClick={() =>
                          saveSettings(
                            {
                              systemPrompt,
                              autoWeb,
                              memoryOnlyMode,
                              voiceEnabled,
                              autoMindmap,
                              openrouterKey,
                              nvidiaKey,
                              googleKey,
                              tavilyKey,
                            },
                            "策略与密钥已保存",
                          )
                        }
                      >
                        保存本模块
                      </VoiceButton>
                      <VoiceButton className="btn secondary" onClick={recoverAccountData}>恢复历史数据</VoiceButton>
                      <VoiceButton className="btn secondary" onClick={importAllDataToCodexMemory}>导入到Codex记忆</VoiceButton>
                    </div>
                  </div>

                  <div id="settings-models" className="card settings-panel" style={{ padding: 12, display: "grid", gap: 10 }}>
                    <h4 style={{ margin: 0 }}>模型 ID 管理</h4>
                    <div style={{ color: "#c0d7f6", fontSize: 12 }}>回答会先走多模型简短讨论，再合并成最终答复。优先建议保留 `glm-5.1` 和 `minimax-m2.7`。</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <VoiceButton
                        className="btn secondary"
                        onClick={() =>
                          saveSettings(
                            { openrouterModels, nvidiaModels, googleModels, openrouterModelSwitches, nvidiaModelSwitches, googleModelSwitches },
                            "模型列表与开关已保存",
                          )
                        }
                      >
                        保存本模块
                      </VoiceButton>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                      <div className="card" style={{ padding: 10, display: "grid", gap: 8 }}>
                        <div style={{ fontWeight: 700, color: "#d8e9ff" }}>NVIDIA 模型</div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input className="input" placeholder="例如 z-ai/glm-5.1" value={newNvidiaModel} onChange={(e) => setNewNvidiaModel(e.target.value)} />
                          <VoiceButton
                            className="btn secondary"
                            onClick={() => {
                              const value = newNvidiaModel.trim();
                              if (!value) return;
                              setNvidiaModels((prev) => (prev.includes(value) ? prev : [...prev, value]));
                              setNvidiaModelSwitches((prev) => ({ ...prev, [value]: true }));
                              setNewNvidiaModel("");
                            }}
                          >
                            添加
                          </VoiceButton>
                        </div>
                        <div style={{ display: "grid", gap: 6 }}>
                          {nvidiaModels.map((modelId) => (
                            <div key={`nvidia-${modelId}`} className="card" style={{ padding: 8, display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                              <span style={{ color: "#dce9ff", fontSize: 12, flex: 1 }}>{modelId}</span>
                              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#b6d2f4", fontSize: 12 }}>
                                <input
                                  type="checkbox"
                                  checked={Object.prototype.hasOwnProperty.call(nvidiaModelSwitches, modelId) ? Boolean(nvidiaModelSwitches[modelId]) : true}
                                  onChange={(e) =>
                                    setNvidiaModelSwitches((prev) => ({
                                      ...prev,
                                      [modelId]: e.target.checked,
                                    }))
                                  }
                                />
                                启用
                              </label>
                              <VoiceButton
                                className="btn danger"
                                onClick={() => {
                                  setNvidiaModels((prev) => prev.filter((x) => x !== modelId));
                                  setNvidiaModelSwitches((prev) => {
                                    const next = { ...prev };
                                    delete next[modelId];
                                    return next;
                                  });
                                }}
                              >
                                删除
                              </VoiceButton>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="card" style={{ padding: 10, display: "grid", gap: 8 }}>
                        <div style={{ fontWeight: 700, color: "#d8e9ff" }}>OpenRouter 模型</div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input className="input" placeholder="例如 openai/gpt-oss-120b:free" value={newOpenrouterModel} onChange={(e) => setNewOpenrouterModel(e.target.value)} />
                          <VoiceButton
                            className="btn secondary"
                            onClick={() => {
                              const value = newOpenrouterModel.trim();
                              if (!value) return;
                              setOpenrouterModels((prev) => (prev.includes(value) ? prev : [...prev, value]));
                              setOpenrouterModelSwitches((prev) => ({ ...prev, [value]: true }));
                              setNewOpenrouterModel("");
                            }}
                          >
                            添加
                          </VoiceButton>
                        </div>
                        <div style={{ display: "grid", gap: 6 }}>
                          {openrouterModels.map((modelId) => (
                            <div key={`openrouter-${modelId}`} className="card" style={{ padding: 8, display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                              <span style={{ color: "#dce9ff", fontSize: 12, flex: 1 }}>{modelId}</span>
                              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#b6d2f4", fontSize: 12 }}>
                                <input
                                  type="checkbox"
                                  checked={Object.prototype.hasOwnProperty.call(openrouterModelSwitches, modelId) ? Boolean(openrouterModelSwitches[modelId]) : true}
                                  onChange={(e) =>
                                    setOpenrouterModelSwitches((prev) => ({
                                      ...prev,
                                      [modelId]: e.target.checked,
                                    }))
                                  }
                                />
                                启用
                              </label>
                              <VoiceButton
                                className="btn danger"
                                onClick={() => {
                                  setOpenrouterModels((prev) => prev.filter((x) => x !== modelId));
                                  setOpenrouterModelSwitches((prev) => {
                                    const next = { ...prev };
                                    delete next[modelId];
                                    return next;
                                  });
                                }}
                              >
                                删除
                              </VoiceButton>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="card" style={{ padding: 10, display: "grid", gap: 8 }}>
                        <div style={{ fontWeight: 700, color: "#d8e9ff" }}>Google AI Studio 模型</div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input className="input" placeholder="例如 gemini-2.5-flash" value={newGoogleModel} onChange={(e) => setNewGoogleModel(e.target.value)} />
                          <VoiceButton
                            className="btn secondary"
                            onClick={() => {
                              const value = newGoogleModel.trim();
                              if (!value) return;
                              setGoogleModels((prev) => (prev.includes(value) ? prev : [...prev, value]));
                              setGoogleModelSwitches((prev) => ({ ...prev, [value]: true }));
                              setNewGoogleModel("");
                            }}
                          >
                            添加
                          </VoiceButton>
                        </div>
                        <div style={{ display: "grid", gap: 6 }}>
                          {googleModels.map((modelId) => (
                            <div key={`google-${modelId}`} className="card" style={{ padding: 8, display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                              <span style={{ color: "#dce9ff", fontSize: 12, flex: 1 }}>{modelId}</span>
                              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#b6d2f4", fontSize: 12 }}>
                                <input
                                  type="checkbox"
                                  checked={Object.prototype.hasOwnProperty.call(googleModelSwitches, modelId) ? Boolean(googleModelSwitches[modelId]) : true}
                                  onChange={(e) =>
                                    setGoogleModelSwitches((prev) => ({
                                      ...prev,
                                      [modelId]: e.target.checked,
                                    }))
                                  }
                                />
                                启用
                              </label>
                              <VoiceButton
                                className="btn danger"
                                onClick={() => {
                                  setGoogleModels((prev) => prev.filter((x) => x !== modelId));
                                  setGoogleModelSwitches((prev) => {
                                    const next = { ...prev };
                                    delete next[modelId];
                                    return next;
                                  });
                                }}
                              >
                                删除
                              </VoiceButton>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div id="settings-account" className="card settings-panel" style={{ padding: 12, display: "grid", gap: 10 }}>
                    <h4 style={{ margin: 0 }}>账号统计与宠物档案</h4>
                    <div className="card" style={{ padding: 10, color: "#bbd3f3", fontSize: 13 }}>
                      今日 token 消耗: {usageToday.total_tokens} | 累计 token 消耗: {usageTotal.total_tokens}
                    </div>
                    <div className="card" style={{ padding: 10, color: "#bbd3f3", fontSize: 13 }}>
                      最近24小时可用率: {quality.availability24h.toFixed(2)}% | 模型切换成功率: {quality.switchSuccess24h.toFixed(2)}%
                    </div>
                    <div className={`pet-luxury card ${petRarityClass}`}>
                      <div className="pet-luxury-head">
                        <div>
                          <div className="pet-luxury-title">{pet.emoji || "🐱"} 宠物档案</div>
                          <div className="pet-luxury-sub">
                            稀有度：{petRarityLabel[pet.rarity || "rare"] || "稀有"} · 突出属性：{petTraitLabel[pet.trait_focus || "wisdom"] || "智慧值"} · 短板属性：{petTraitLabel[pet.trait_weakness || "snark"] || "毒舌值"}
                          </div>
                        </div>
                      <div style={{ display: "grid", justifyItems: "end", gap: 6 }}>
                        <div className="pet-state-chip">{sending ? "思考中互动" : pet.mood || "idle"}</div>
                        <div className="pet-level-badge">LV {petLevel} · 综合 {petAverage}</div>
                      </div>
                    </div>
                      <div style={{ display: "grid", gap: 8 }}>
                        <input className="input" value={petNameDraft} onChange={(e) => setPetNameDraft(e.target.value)} placeholder="宠物名称" />
                        <VoiceButton className="btn secondary" voiceText="宠物名称已保存" onClick={savePetProfile}>保存宠物名称</VoiceButton>
                        <VoiceButton
                          className="btn secondary"
                          onClick={() =>
                            saveSettings(
                              {
                                openrouterKey,
                                nvidiaKey,
                                googleKey,
                                tavilyKey,
                                autoWeb,
                                memoryOnlyMode,
                                voiceEnabled,
                                autoMindmap,
                              },
                              "账号模块配置已保存",
                            )
                          }
                        >
                          保存本模块
                        </VoiceButton>
                      </div>
                      <div className="pet-bars">
                        {Object.entries(pet.attributes || {}).map(([k, v]) => (
                          <div key={k} className="pet-bar-item">
                            <div className="pet-bar-label-row">
                              <span>{petTraitLabel[k] || k}</span>
                              <span>{Math.max(0, Math.min(100, Number(v || 0)))}%</span>
                            </div>
                            <div className="pet-bar-track">
                              <div className="pet-bar-fill" style={{ width: `${Math.max(0, Math.min(100, Number(v || 0)))}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    <div className="pet-energy-row">
                      <span>能量</span>
                      <div className="pet-energy-track">
                        <div className="pet-energy-fill" style={{ width: `${Math.max(0, Math.min(100, Number(pet.energy || 0)))}%` }} />
                      </div>
                    </div>
                    <div className="pet-energy-row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
                      <span>经验</span>
                      <div className="pet-energy-track">
                        <div className="pet-energy-fill" style={{ width: `${petXpPercent}%` }} />
                      </div>
                      <span style={{ color: "#d2e8ff", fontSize: 11 }}>{petXp}/{petXpToNext}</span>
                    </div>
                  </div>
                </div>

                  <div id="settings-memory" className="card settings-panel" style={{ padding: 12, display: "grid", gap: 10 }}>
                    <h4 style={{ margin: 0 }}>长期记忆（新增 / 搜索 / 修改 / 删除）</h4>
                    <div style={{ color: "#b8ccea", fontSize: 13 }}>
                      总文件数: {memoryStats.total_files} | 总行数: {memoryStats.total_lines} | 最近更新时间: {memoryStats.latest_memory_update || "暂无"}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
                      <input className="input" placeholder="记忆标题" value={newMemoryTitle} onChange={(e) => setNewMemoryTitle(e.target.value)} />
                      <input className="input" placeholder="记忆内容（精简可复用）" value={newMemoryContent} onChange={(e) => setNewMemoryContent(e.target.value)} />
                      <select className="input" value={newMemoryStatus} onChange={(e) => setNewMemoryStatus(e.target.value as "valid" | "outdated")}>
                        <option value="valid">有效</option>
                        <option value="outdated">过时</option>
                      </select>
                      <VoiceButton className="btn secondary" onClick={addMemory}><Plus size={14} /> 新增记忆</VoiceButton>
                    </div>
                    <input className="input" placeholder="搜索长期记忆（自动高亮关键词）" value={memorySearchText} onChange={(e) => setMemorySearchText(e.target.value)} />
                    <VoiceButton className="btn secondary" onClick={() => void triggerNightlyRollup(true)}>立即执行今晚复盘</VoiceButton>

                    <div className="scroll-y" style={{ maxHeight: 430, display: "grid", gap: 8 }}>
                      {filteredMemoryEntries.map((entry) => {
                        const isEditing = editingMemoryId === entry.id;
                        return (
                          <div key={entry.id} className="card" style={{ padding: 10 }}>
                            {isEditing ? (
                              <>
                                <input className="input" value={editingMemoryTitle} onChange={(e) => setEditingMemoryTitle(e.target.value)} />
                                <textarea className="input" style={{ marginTop: 8, minHeight: 80 }} value={editingMemoryContent} onChange={(e) => setEditingMemoryContent(e.target.value)} />
                                <select className="input" style={{ marginTop: 8 }} value={editingMemoryStatus} onChange={(e) => setEditingMemoryStatus(e.target.value as "valid" | "outdated")}>
                                  <option value="valid">有效</option>
                                  <option value="outdated">过时</option>
                                </select>
                                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                  <VoiceButton className="btn secondary" onClick={saveEditMemory}><Save size={14} /> 保存修改</VoiceButton>
                                  <VoiceButton className="btn secondary" onClick={cancelEditMemory}><X size={14} /> 取消</VoiceButton>
                                </div>
                              </>
                            ) : (
                              <>
                                <div style={{ fontWeight: 700 }}>{renderHighlighted(entry.title, memorySearchText)}</div>
                                <div style={{ color: "#a8bfe1", fontSize: 12 }}>{entry.entry_type}</div>
                                <div style={{ color: "#8fb6de", fontSize: 12, marginTop: 4 }}>
                                  状态: {entry.status === "outdated" ? "过时" : "有效"} · 价值分: {Number(entry.importance || 0).toFixed(2)}
                                </div>
                                <div style={{ color: "#dce9ff", marginTop: 6, whiteSpace: "pre-wrap" }}>
                                  {renderHighlighted(entry.content, memorySearchText)}
                                </div>
                                <div style={{ color: "#8ca7ce", fontSize: 12, marginTop: 6 }}>索引: {entry.source_pointer || entry.id}</div>
                                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                  <VoiceButton
                                    className="btn secondary"
                                    onClick={async () => {
                                      const response = await fetch("/api/account/import-codex-memory", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ memoryEntryId: entry.id }),
                                      });
                                      const data = await response.json().catch(() => ({}));
                                      if (!response.ok) {
                                        showToast({ type: "error", text: data.error || "导入失败" });
                                        return;
                                      }
                                      showToast({ type: "success", text: data.message || "已导入这条记忆到 Codex 文件" });
                                    }}
                                  >
                                    导入到Codex
                                  </VoiceButton>
                                  <VoiceButton className="btn secondary" onClick={() => startEditMemory(entry)}><Pencil size={14} /> 修改</VoiceButton>
                                  <VoiceButton className="btn danger" onClick={() => deleteMemory(entry.id)} disabled={deletingMemoryId === entry.id}>
                                    <Trash2 size={14} /> {deletingMemoryId === entry.id ? "删除中..." : "删除"}
                                  </VoiceButton>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                      {filteredMemoryEntries.length === 0 ? (
                        <div style={{ color: "#90aed2", fontSize: 13, padding: "4px 2px" }}>没有匹配到关键词，换个词再试。</div>
                      ) : null}
                    </div>
                  </div>

                  <div id="settings-changelog" className="card settings-panel" style={{ padding: 12, display: "grid", gap: 10 }}>
                    <h4 style={{ margin: 0 }}>更新日志</h4>
                    <div style={{ color: "#b8ccea", fontSize: 13 }}>已记录历史修改，后续每次版本更新会继续追加。</div>
                    <div className="scroll-y" style={{ maxHeight: 260, display: "grid", gap: 8 }}>
                      {changeLogs.length === 0 ? (
                        <div style={{ color: "#9bb3d4", fontSize: 13 }}>暂无更新日志</div>
                      ) : (
                        changeLogs.map((item) => (
                          <div key={item.release_key} className="card" style={{ padding: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                              <div style={{ fontWeight: 700 }}>{item.title}</div>
                              <div style={{ color: "#8ca7ce", fontSize: 12, whiteSpace: "nowrap" }}>{formatTime(item.changed_at)}</div>
                            </div>
                            <div style={{ marginTop: 6, color: "#d7e7ff", whiteSpace: "pre-wrap" }}>{item.details}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        ) : mainView === "quality" ? (
          <div className="chat-frame card page-view">
            <header className="chat-header">
              <div className="chat-title-wrap">
                <div className="chat-title">Answer Quality Review</div>
                <div className="chat-subtitle">答案质量自动评分历史图 + 模型对比 + 任务筛选</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select className="input" style={{ width: 220 }} value={qualityModelFilter} onChange={async (e) => { setQualityModelFilter(e.target.value); await loadQualityReview(e.target.value, qualityTaskFilter); }}>
                  <option value="all">全部模型</option>
                  {(qualityReview?.modelCompare || []).map((m) => (
                    <option key={m.model_id} value={m.model_id}>{m.model_id}</option>
                  ))}
                </select>
                <select className="input" style={{ width: 170 }} value={qualityTaskFilter} onChange={async (e) => { setQualityTaskFilter(e.target.value); await loadQualityReview(qualityModelFilter, e.target.value); }}>
                  <option value="all">全部任务类型</option>
                  <option value="web">联网任务</option>
                  <option value="file">文件任务</option>
                  <option value="local">本地任务</option>
                </select>
                <VoiceButton className="btn secondary" onClick={() => setMainView("chat")}>返回对话</VoiceButton>
              </div>
            </header>
            <section className="chat-messages scroll-y">
              {!qualityReview ? (
                <div className="chat-empty">暂无质量数据</div>
              ) : (
                <>
                  <div className="quality-score-chart">
                    {(qualityReview.dailyQuality || []).map((d) => (
                      <div key={`main-q-${d.day}`} className="quality-score-col">
                        <div className="quality-score-value">{Math.round(d.score)}</div>
                        <div className="quality-score-track"><div className="quality-score-fill" style={{ height: `${Math.max(0, Math.min(100, d.score))}%` }} /></div>
                        <div className="quality-score-day">{d.day}</div>
                      </div>
                    ))}
                  </div>
                  <div className="card" style={{ marginTop: 12, padding: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>模型对比</div>
                    {(qualityReview.modelCompare || []).map((m) => (
                      <div key={m.model_id} style={{ display: "flex", justifyContent: "space-between", color: "#c8ddfb", fontSize: 13, padding: "4px 0" }}>
                        <span>{m.model_id}</span><span>{m.avg_score} 分 · {m.count} 次</span>
                      </div>
                    ))}
                  </div>
                  <div className="card" style={{ marginTop: 12, padding: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>任务类型对比</div>
                    {(qualityReview.taskTypeBreakdown || []).map((t) => (
                      <div key={t.task_type} style={{ display: "flex", justifyContent: "space-between", color: "#c8ddfb", fontSize: 13, padding: "4px 0" }}>
                        <span>{t.task_type === "web" ? "联网任务" : t.task_type === "file" ? "文件任务" : "本地任务"}</span>
                        <span>{t.avg_score} 分 · {t.count} 次</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>
        ) : mainView === "weekly" ? (
          <div className="chat-frame card page-view">
            <header className="chat-header">
              <div className="chat-title-wrap">
                <div className="chat-title">Today Workbench</div>
                <div className="chat-subtitle">待办、关键结论、风险提醒同屏</div>
              </div>
              <VoiceButton className="btn secondary" onClick={() => setMainView("chat")}>返回对话</VoiceButton>
            </header>
            <section className="chat-messages scroll-y">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
                <div className="card" style={{ padding: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>待办</div>
                  {(weeklyReport?.suggestions || []).slice(0, 5).map((x, i) => <div key={i} style={{ color: "#c8ddfb", fontSize: 13 }}>{i + 1}. {x}</div>)}
                </div>
                <div className="card" style={{ padding: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>关键结论</div>
                  {(weeklyReport?.keyDecisions || []).slice(0, 5).map((x, i) => <div key={i} style={{ color: "#c8ddfb", fontSize: 13 }}>{i + 1}. {x.key_conclusion}</div>)}
                </div>
                <div className="card" style={{ padding: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>风险提醒</div>
                  {(qualityReview?.weakLinks || []).slice(0, 5).map((x, i) => <div key={i} style={{ color: "#ffc7b1", fontSize: 13 }}>{i + 1}. {x}</div>)}
                </div>
              </div>
            </section>
          </div>
        ) : mainView === "diary" ? (
          <div className="chat-frame card page-view">
            <header className="chat-header">
              <div className="chat-title-wrap">
                <div className="chat-title">Diary Journal</div>
                <div className="chat-subtitle">每天三块：成功日记 + 赚钱日记 + 高考日记（自动计入长期记忆）</div>
              </div>
              <VoiceButton className="btn secondary" onClick={() => setMainView("chat")}>返回对话</VoiceButton>
            </header>
            <section className="chat-messages scroll-y">
              <div className="card settings-panel" style={{ padding: 14, display: "grid", gap: 10 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <div className="settings-section-title" style={{ margin: 0 }}>日期</div>
                  <input className="input" style={{ maxWidth: 220 }} type="date" value={diaryDate} onChange={(e) => setDiaryDate(e.target.value)} />
                  <VoiceButton className="btn" onClick={() => saveDiary("all")}>保存全部</VoiceButton>
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  <div className="card" style={{ padding: 10, display: "grid", gap: 6 }}>
                    <div style={{ fontWeight: 700, color: "#ffd9a6", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span>成功日记</span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <VoiceButton className="btn secondary" type="button" onClick={() => saveDiary("success")}>
                          <Save size={14} /> 保存本块
                        </VoiceButton>
                        <VoiceButton
                          className="btn secondary"
                          type="button"
                          onClick={() => {
                            if (!speechSupported) {
                              showToast({ type: "error", text: "当前浏览器不支持语音输入" });
                              return;
                            }
                            if (isListening && voiceTarget === "diary-success") {
                              stopVoiceInput();
                            } else {
                              startVoiceInput("diary-success");
                            }
                          }}
                        >
                          <Mic size={14} /> {isListening && voiceTarget === "diary-success" ? "停止语音" : "语音输入"}
                        </VoiceButton>
                      </div>
                    </div>
                    <textarea
                      className="input"
                      style={{ minHeight: 120 }}
                      placeholder="今天我做成了什么？为什么做成？下次如何复用？"
                      value={successJournal}
                      onChange={(e) => setSuccessJournal(e.target.value)}
                    />
                    <div
                      className="card"
                      style={{
                        padding: 12,
                        background: "linear-gradient(135deg, rgba(255, 202, 122, 0.18) 0%, rgba(120, 211, 255, 0.14) 100%)",
                        border: "1px solid rgba(255, 209, 149, 0.35)",
                      }}
                    >
                      <div style={{ fontSize: 12, color: "#ffd8a9", marginBottom: 6 }}>成功日记展示</div>
                      <div style={{ color: "#eef6ff", lineHeight: 1.7, whiteSpace: "pre-wrap", minHeight: 42 }}>
                        {successJournal.trim() || "写下今天最关键的一次完成，系统会把它整理成长期可复用的成功经验。"}
                      </div>
                    </div>
                  </div>
                  <div className="card" style={{ padding: 10, display: "grid", gap: 6 }}>
                    <div style={{ fontWeight: 700, color: "#ffd9a6", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span>赚钱日记</span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <VoiceButton className="btn secondary" type="button" onClick={() => saveDiary("money")}>
                          <Save size={14} /> 保存本块
                        </VoiceButton>
                        <VoiceButton
                          className="btn secondary"
                          type="button"
                          onClick={() => {
                            if (!speechSupported) {
                              showToast({ type: "error", text: "当前浏览器不支持语音输入" });
                              return;
                            }
                            if (isListening && voiceTarget === "diary-money") {
                              stopVoiceInput();
                            } else {
                              startVoiceInput("diary-money");
                            }
                          }}
                        >
                          <Mic size={14} /> {isListening && voiceTarget === "diary-money" ? "停止语音" : "语音输入"}
                        </VoiceButton>
                      </div>
                    </div>
                    <textarea
                      className="input"
                      style={{ minHeight: 120 }}
                      placeholder="今天和赚钱/变现相关做了什么？数据如何？明天的动作是什么？"
                      value={moneyJournal}
                      onChange={(e) => setMoneyJournal(e.target.value)}
                    />
                  </div>
                  <div className="card" style={{ padding: 10, display: "grid", gap: 6 }}>
                    <div style={{ fontWeight: 700, color: "#ffd9a6", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span>高考日记</span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <VoiceButton className="btn secondary" type="button" onClick={() => saveDiary("gaokao")}>
                          <Save size={14} /> 保存本块
                        </VoiceButton>
                        <VoiceButton
                          className="btn secondary"
                          type="button"
                          onClick={() => {
                            if (!speechSupported) {
                              showToast({ type: "error", text: "当前浏览器不支持语音输入" });
                              return;
                            }
                            if (isListening && voiceTarget === "diary-gaokao") {
                              stopVoiceInput();
                            } else {
                              startVoiceInput("diary-gaokao");
                            }
                          }}
                        >
                          <Mic size={14} /> {isListening && voiceTarget === "diary-gaokao" ? "停止语音" : "语音输入"}
                        </VoiceButton>
                      </div>
                    </div>
                    <textarea
                      className="input"
                      style={{ minHeight: 120 }}
                      placeholder="今天高考复习做了什么？卡点在哪？下一步计划是什么？"
                      value={gaokaoJournal}
                      onChange={(e) => setGaokaoJournal(e.target.value)}
                    />
                  </div>
                </div>
                {isListening && voiceTarget !== "chat" && speechInterim ? (
                  <div className="helper-note is-voice">
                    日记语音临时识别：{speechInterim}
                  </div>
                ) : null}
              </div>

              <div className="card settings-panel" style={{ marginTop: 10, padding: 12, display: "grid", gap: 10 }}>
                <div style={{ fontWeight: 700 }}>每日状态趋势（近14天）</div>
                {diaryStatusSeries.length > 0 ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    {diaryStatusSeries.map((item) => (
                      <div key={item.day} style={{ display: "grid", gridTemplateColumns: "56px 1fr 38px", gap: 8, alignItems: "center" }}>
                        <div style={{ color: "#9cb9dc", fontSize: 12 }}>{item.day}</div>
                        <div
                          style={{
                            height: 10,
                            borderRadius: 999,
                            background: "rgba(103, 147, 210, 0.24)",
                            overflow: "hidden",
                            border: "1px solid rgba(124, 160, 216, 0.36)",
                          }}
                        >
                          <div
                            style={{
                              width: `${item.score}%`,
                              height: "100%",
                              background:
                                item.score >= 70
                                  ? "linear-gradient(90deg, #5fd4a8 0%, #8de2ba 100%)"
                                  : item.score >= 45
                                    ? "linear-gradient(90deg, #7ab8ff 0%, #8bc8ff 100%)"
                                    : "linear-gradient(90deg, #ff9d8f 0%, #ffb39f 100%)",
                            }}
                          />
                        </div>
                        <div style={{ color: "#dce9ff", fontSize: 12, textAlign: "right" }}>{item.score}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "#9bb3d4", fontSize: 13 }}>暂无趋势数据，先写几天日记即可自动生成。</div>
                )}
              </div>

              <div className="card settings-panel" style={{ marginTop: 10, padding: 12, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>最近日记</div>
                <div className="scroll-y" style={{ maxHeight: 260, display: "grid", gap: 8 }}>
                  {diaryHistory.map((d) => (
                    <div key={d.diary_date} className="card" style={{ padding: 10, display: "grid", gap: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <div style={{ fontWeight: 700, color: "#d9e8ff" }}>
                          {d.diary_date} · 最近更新 {formatTime(d.updated_at)}
                        </div>
                        <VoiceButton
                          className="btn secondary"
                          onClick={() => {
                            setDiaryDate(d.diary_date);
                            setSuccessJournal(d.success_journal || "");
                            setMoneyJournal(d.money_journal || "");
                            setGaokaoJournal(d.gaokao_journal || "");
                          }}
                        >
                          载入编辑
                        </VoiceButton>
                      </div>
                      <div style={{ color: "#9cb9dc", fontSize: 12 }}>分类：{(d.categories || ["日常"]).join(" / ")}</div>
                      <div style={{ color: "#dce9ff", fontSize: 13, whiteSpace: "pre-wrap" }}>
                        成功日记：{d.success_journal || "(空)"}
                      </div>
                      <div style={{ color: "#dce9ff", fontSize: 13, whiteSpace: "pre-wrap" }}>
                        赚钱日记：{d.money_journal || "(空)"}
                      </div>
                      <div style={{ color: "#dce9ff", fontSize: 13, whiteSpace: "pre-wrap" }}>
                        高考日记：{d.gaokao_journal || "(空)"}
                      </div>
                    </div>
                  ))}
                  {diaryHistory.length === 0 ? (
                    <div style={{ color: "#9bb3d4", fontSize: 13 }}>暂无日记，先写今天的一条。</div>
                  ) : null}
                </div>
              </div>
            </section>
          </div>
        ) : !hasEnteredWorkspace ? (
          <div className="chat-frame card intro-mode">
            <div className="card intro-card" style={{ width: "min(860px, 100%)", padding: 22, display: "grid", gap: 12 }}>
              <div style={{ fontSize: 13, color: "#98b6db" }}>网站公告</div>
              <div style={{ color: "#e7f2ff", whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
                {announcement || "暂无公告"}
              </div>
              <textarea
                className="input"
                style={{ minHeight: 90 }}
                placeholder="输入你现在最想解决的问题，按 Enter 进入对话"
                value={introInput}
                onChange={(e) => setIntroInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    enterWorkspace();
                  }
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div style={{ color: "#9bb7d9", fontSize: 12 }}>
                  {pet.emoji || "🐱"} {pet.name} · {pet.trait || "你的学习伙伴"}
                </div>
                <VoiceButton className="btn" voiceText="欢迎回来，正在进入对话区" onClick={enterWorkspace}>
                  进入对话
                </VoiceButton>
              </div>
            </div>
          </div>
        ) : (
        <div className="chat-frame card">
          <header className="chat-header">
            <div className="chat-title-wrap">
              <div className="chat-title">{activeConversation?.title || "请选择或新建对话"}</div>
              <div className="chat-subtitle">支持多模型兜底、联网摘要、文件融合、长期记忆</div>
            </div>
            <div className="chat-stats">
              <span>今日消耗: {usageToday.total_tokens}</span>
              <span>累计消耗: {usageTotal.total_tokens}</span>
              <span>{petActionText}</span>
            </div>
          </header>

          <div className="command-deck card">
            <div className="command-deck-title">操作指挥台</div>
            <div className="command-deck-actions">
              <VoiceButton className="btn secondary command-pill" voiceText="已打开操作指挥台" onClick={() => setShowCommandCenter(true)}>
                打开全局指挥台（Ctrl+K）
              </VoiceButton>
              <VoiceButton className="btn secondary command-pill" onClick={() => setInput("请用三段式回答：结论、证据、下一步。")}>
                三段式输出
              </VoiceButton>
              <VoiceButton className="btn secondary command-pill" onClick={() => setInput("把这次对话整理为行动清单，每条包含截止时间。")}>
                生成行动清单
              </VoiceButton>
              <VoiceButton className="btn secondary command-pill" voiceText="已打开回答质量复盘" onClick={async () => { await loadQualityReview(); setMainView("quality"); }}>
                打开答案质量历史图
              </VoiceButton>
              <VoiceButton className="btn secondary command-pill" voiceText="已打开个人效率周报" onClick={async () => { await loadWeeklyReport(); setMainView("weekly"); }}>
                打开个人效率周报
              </VoiceButton>
              {isAdmin ? (
                <VoiceButton className="btn secondary command-pill" voiceText="管理员后台已打开" onClick={async () => { await loadAdmin(); setShowAdmin(true); }}>
                  <Shield size={14} /> 打开管理员后台
                </VoiceButton>
              ) : null}
            </div>
          </div>

          <div className={`today-workbench card ${workbenchCollapsed ? "is-collapsed" : ""}`}>
            <div className="today-workbench-head">
              <div>
                <div className="today-workbench-title">今日工作台</div>
                <div className="today-workbench-subtitle">待办、关键结论、风险提醒同屏</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <VoiceButton
                  className="btn secondary"
                  voiceText={workbenchCollapsed ? "今日工作台已展开" : "今日工作台已收起"}
                  onClick={() => setWorkbenchCollapsed((v) => !v)}
                >
                  {workbenchCollapsed ? "展开工作台" : "收起工作台"}
                </VoiceButton>
                <VoiceButton className="btn secondary" onClick={async () => { await Promise.all([loadWeeklyReport(), loadQualityReview("all", "all")]); setMainView("weekly"); }}>
                  查看完整工作台
                </VoiceButton>
              </div>
            </div>
            <div className="today-workbench-grid">
              <div className="today-workbench-col">
                <div className="today-workbench-col-title">待办</div>
                {(weeklyReport?.suggestions || []).slice(0, 3).map((x, i) => (
                  <div key={`todo-${i}`} className="today-workbench-item">{i + 1}. {x}</div>
                ))}
                {(!weeklyReport?.suggestions || weeklyReport.suggestions.length === 0) ? (
                  <div className="today-workbench-empty">暂无待办，发送一条消息即可自动生成。</div>
                ) : null}
              </div>
              <div className="today-workbench-col">
                <div className="today-workbench-col-title">关键结论</div>
                {(weeklyReport?.keyDecisions || []).slice(0, 3).map((x, i) => (
                  <div key={`decision-${i}`} className="today-workbench-item">{i + 1}. {x.key_conclusion}</div>
                ))}
                {(!weeklyReport?.keyDecisions || weeklyReport.keyDecisions.length === 0) ? (
                  <div className="today-workbench-empty">暂无关键结论。</div>
                ) : null}
              </div>
              <div className="today-workbench-col">
                <div className="today-workbench-col-title">风险提醒</div>
                {(qualityReview?.weakLinks || []).slice(0, 3).map((x, i) => (
                  <div key={`risk-${i}`} className="today-workbench-item risk">{i + 1}. {x}</div>
                ))}
                {(!qualityReview?.weakLinks || qualityReview.weakLinks.length === 0) ? (
                  <div className="today-workbench-empty">暂无风险提醒。</div>
                ) : null}
              </div>
            </div>
          </div>

          <section
            ref={(el) => {
              messagesContainerRef.current = el;
            }}
            onScroll={updateScrollState}
            className="chat-messages scroll-y"
          >
            {messages.length === 0 ? <div className="chat-empty">回答区：发送消息后会显示对话记录，可上下滚动。</div> : null}

            {messages.map((message) => {
              const messageNumericId = typeof message.id === "string" ? Number(message.id) : message.id;
              const contentForFeed =
                message.role === "assistant" ? splitAssistantContent(message.content).preview : message.content;
              return (
              <div
                key={message.id}
                className={`message-row ${message.role === "user" ? "is-user" : "is-assistant"}`}
              >
                <div
                  className={`message-avatar ${message.role === "user" ? "is-user" : "is-assistant"}`}
                >
                  {message.role === "user" ? (
                    user?.imageUrl ? (
                      <img
                        src={user.imageUrl}
                        alt="user avatar"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <span>我</span>
                    )
                  ) : (
                    <img
                      src="/assistant-avatar.jpg"
                      alt="assistant avatar"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  )}
                </div>

                <div
                  className={`card message-bubble ${message.role === "user" ? "is-user" : "is-assistant"} ${highlightMessageId === message.id ? "is-highlight" : ""} ${raisedMessageId === messageNumericId ? "is-raised" : ""}`}
                >
                <div className="message-meta">
                  {message.role === "user" ? "你" : "Agent"}
                  {(() => {
                    const provider = String(message.model_provider || "").toLowerCase();
                    const model = String(message.model_id || "").toLowerCase();
                    const isFallbackLike =
                      !provider ||
                      provider === "fallback" ||
                      provider === "local" ||
                      model.includes("local-safe-mode") ||
                      model.includes("local-council-synthesis");
                    if (isFallbackLike) return "";
                    return ` · ${message.model_provider}/${message.model_id}`;
                  })()}
                </div>
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {contentForFeed}
                  </ReactMarkdown>
                </div>

                {message.role === "assistant" ? (
                  <div className="assistant-actions">
                    <VoiceButton className="btn secondary" onClick={() => copyAnswer(message.content)}>
                      <Copy size={14} /> 复制答案
                    </VoiceButton>
                    <VoiceButton
                      className="btn secondary"
                      onClick={() => Number.isFinite(messageNumericId) && messageNumericId > 0 && regenerateAnswer(messageNumericId)}
                      disabled={!Number.isFinite(messageNumericId) || messageNumericId <= 0 || regeneratingMessageId === messageNumericId}
                    >
                      {regeneratingMessageId === messageNumericId ? (
                        <><Loader2 className="animate-spin" size={14} /> 重生成中</>
                      ) : (
                        <><RefreshCw size={14} /> 重新生成</>
                      )}
                    </VoiceButton>
                    <VoiceButton
                      className="btn secondary"
                      onClick={() => Number.isFinite(messageNumericId) && messageNumericId > 0 && sendFeedback(messageNumericId, "up")}
                      disabled={!Number.isFinite(messageNumericId) || messageNumericId <= 0}
                    >
                      <ThumbsUp size={14} /> 点赞
                    </VoiceButton>
                    <VoiceButton
                      className="btn secondary"
                      onClick={() => Number.isFinite(messageNumericId) && messageNumericId > 0 && sendFeedback(messageNumericId, "down")}
                      disabled={!Number.isFinite(messageNumericId) || messageNumericId <= 0}
                    >
                      <ThumbsDown size={14} /> 踩
                    </VoiceButton>
                    <VoiceButton className="btn secondary" onClick={() => setInsightMessage(message)}>
                      查看详情
                    </VoiceButton>
                  </div>
                ) : message.role === "user" ? (
                  <div className="assistant-actions">
                    <VoiceButton className="btn secondary" onClick={() => copyAnswer(message.content)}>
                      <Copy size={14} /> 复制提问
                    </VoiceButton>
                  </div>
                ) : null}
                </div>
              </div>
            )})}

            {showJumpBottom ? (
              <VoiceButton
                type="button"
                className="btn secondary jump-bottom-btn"
                onClick={() => scrollToBottom(true)}
              >
                <ChevronDown size={14} /> 一键到底部
              </VoiceButton>
            ) : null}
          </section>

          <footer className="chat-footer">
            <div className="input-shell card">
              <div className="quick-action-row">
                <VoiceButton className="btn secondary quick-chip" onClick={() => setInput("请先给我一句结论，再给3条关键依据。")}>
                  只看结论
                </VoiceButton>
                <VoiceButton className="btn secondary quick-chip" onClick={() => setInput("把这段对话整理成可执行清单，按优先级排序。")}>
                  执行清单
                </VoiceButton>
                <VoiceButton className="btn secondary quick-chip" onClick={() => setInput("请做1分钟复盘：我做对了什么、下一步做什么。")}>
                  1分钟复盘
                </VoiceButton>
              </div>
              <textarea
                className="input chat-input"
                placeholder="输入框：可上传/粘贴多个文件、图片、音频、视频。Enter 发送，Shift+Enter 换行。"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData?.files || []);
                  if (!files.length) return;
                  e.preventDefault();
                  setSelectedFiles((prev) => {
                    const next = [...prev];
                    for (const file of files) {
                      const exists = next.some(
                        (x) => x.name === file.name && x.size === file.size && x.lastModified === file.lastModified,
                      );
                      if (!exists) next.push(file);
                    }
                    return next;
                  });
                  showToast({ type: "success", text: `已粘贴 ${files.length} 个文件` });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />

              <div className="input-action-row">
                <div className="left-actions">
                  <label className="btn secondary upload-btn">
                    <Upload size={14} /> 上传文件
                    <input
                      hidden
                      type="file"
                      multiple
                      accept="image/*,video/*,audio/*,.txt,.md,.csv,.json,.xml,.html,.pdf,.docx"
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        if (!files.length) return;
                        setSelectedFiles((prev) => {
                          const next = [...prev];
                          for (const file of files) {
                            const exists = next.some(
                              (x) => x.name === file.name && x.size === file.size && x.lastModified === file.lastModified,
                            );
                            if (!exists) next.push(file);
                          }
                          return next;
                        });
                      }}
                    />
                  </label>
                  <VoiceButton
                    className="btn secondary"
                    type="button"
                    voiceText={isListening ? "语音输入已停止" : "开始语音输入，请直接说话"}
                    onClick={() => {
                      if (!speechSupported) {
                        showToast({ type: "error", text: "当前浏览器不支持语音输入" });
                        return;
                      }
                      if (isListening) {
                        stopVoiceInput();
                      } else {
                        startVoiceInput("chat");
                      }
                    }}
                  >
                    <Mic size={14} /> {isListening ? "停止语音" : "语音输入"}
                  </VoiceButton>
                </div>

                <VoiceButton className="btn send-btn" voiceText="收到啦，正在为你处理" onClick={() => sendMessage()} disabled={sending}>
                  {sending ? <Loader2 className="animate-spin" size={16} /> : <><Send size={14} /> 发送</>}
                </VoiceButton>
              </div>

              {selectedFiles.length > 0 ? (
                <div className="helper-note" style={{ display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>已导入待发送：{selectedFiles.length} 个</span>
                    <VoiceButton className="btn secondary" onClick={() => setSelectedFiles([])}>清空</VoiceButton>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {selectedFiles.map((f, idx) => (
                      <span key={`${f.name}-${f.size}-${idx}`} className="btn secondary" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                        <button
                          type="button"
                          aria-label={`删除 ${f.name}`}
                          onClick={() => setSelectedFiles((prev) => prev.filter((_, i) => i !== idx))}
                          style={{ all: "unset", cursor: "pointer", color: "#ffb8b8", lineHeight: 1 }}
                        >
                          <X size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {isListening && speechInterim ? (
                <div className="helper-note is-voice">
                  语音临时识别：{speechInterim}
                </div>
              ) : null}
            </div>
          </footer>
        </div>
        )}
      </main>

      {insightMessage ? (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.62)", display: "grid", placeItems: "center", padding: 14, zIndex: 45 }}
          onClick={() => setInsightMessage(null)}
        >
          <div className="card scroll-y" style={{ width: "min(1360px, 98vw)", maxHeight: "90vh", padding: 14, display: "grid", gap: 10 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <h3 style={{ margin: 0 }}>回答详情卡片</h3>
              <VoiceButton className="btn secondary" onClick={() => setInsightMessage(null)}>关闭</VoiceButton>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span className="btn secondary" style={{ padding: "4px 8px", fontSize: 12 }}>
                把握度: {insightMessage.confidence_level === "high" ? "高" : insightMessage.confidence_level === "low" ? "低" : "中"}
              </span>
              <span className="btn secondary" style={{ padding: "4px 8px", fontSize: 12 }}>
                联网: {insightMessage.web_used ? "是" : "否"}
              </span>
              <span className="btn secondary" style={{ padding: "4px 8px", fontSize: 12 }}>
                文件: {insightMessage.files_used ? "是" : "否"}
              </span>
              <span className="btn secondary" style={{ padding: "4px 8px", fontSize: 12 }}>
                {(() => {
                  const provider = String(insightMessage.model_provider || "").toLowerCase();
                  const model = String(insightMessage.model_id || "").toLowerCase();
                  const isFallbackLike =
                    !provider ||
                    provider === "fallback" ||
                    provider === "local" ||
                    model.includes("local-safe-mode") ||
                    model.includes("local-council-synthesis");
                  if (isFallbackLike) return "模型: 已启用兜底保护";
                  return `模型: ${insightMessage.model_provider || "-"} / ${insightMessage.model_id || "-"}`;
                })()}
              </span>
            </div>

            {(() => {
              const split = splitAssistantContent(insightMessage.content || "");
              return (
                <>
                  {split.preview ? (
                    <div className="card source-card">
                      <div className="source-title">回答正文</div>
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {split.preview}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ) : null}
                  {split.evidence ? (
                    <div className="card source-card">
                      <div className="source-title">回答依据</div>
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {split.evidence}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ) : null}
                </>
              );
            })()}

            {(() => {
              const radar = getKnowledgeRadar(insightMessage);
              const polygon = buildRadarPoints(radar, 34, 42);
              return (
                <div className="cred-radar card">
                  <div className="cred-radar-title">知识可信度雷达</div>
                  <div className="cred-radar-grid">
                    <svg width="84" height="84" viewBox="0 0 84 84" className="cred-radar-svg" aria-label="知识可信度雷达图">
                      <polygon points="42,8 76,29 63,68 21,68 8,29" className="cred-radar-base" />
                      <polygon points={polygon} className="cred-radar-shape" />
                    </svg>
                    <div className="cred-radar-list">
                      {radarAxis.map((axis) => (
                        <div key={axis.key} className="cred-radar-item">
                          <span>{axis.label}</span>
                          <span>{Math.round(radar[axis.key])}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}

            {insightMessage.web_used && Array.isArray(insightMessage.sources) && insightMessage.sources.length > 0 ? (
              <div className="card source-card">
                <div className="source-title">
                  <Globe size={14} style={{ display: "inline" }} /> 联网来源与摘要
                </div>
                <div className="source-list">
                  {insightMessage.sources.map((source, index) => (
                    <a key={index} href={source.url} target="_blank" rel="noreferrer" className="btn secondary source-item">
                      <div className="source-item-title">{source.title}</div>
                      <div className="source-item-snippet">{source.snippet}</div>
                    </a>
                  ))}
                </div>
              </div>
            ) : null}

            {insightMessage.mindmap_url ? (
              <div className="card source-card" style={{ marginTop: 2 }}>
                <div className="source-title">本次对话核心摘要思维导图（Pollinations.ai）</div>
                <a
                  href={insightMessage.mindmap_url}
                  target="_blank"
                  rel="noreferrer"
                  className="btn secondary"
                  style={{ marginBottom: 8, display: "inline-flex" }}
                >
                  查看原图
                </a>
                <img
                  src={insightMessage.mindmap_url}
                  alt="mindmap summary"
                  style={{
                    width: "100%",
                    maxHeight: 420,
                    objectFit: "contain",
                    borderRadius: 12,
                    border: "1px solid rgba(116,153,205,0.32)",
                    display: "block",
                    background: "rgba(9, 15, 26, 0.82)",
                  }}
                  loading="lazy"
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showAdmin ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", padding: 14, zIndex: 30 }} onClick={() => setShowAdmin(false)}>
          <div className="card scroll-y" style={{ width: "min(900px, 100%)", maxHeight: "88vh", padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>管理员后台</h3>
              <VoiceButton className="btn secondary" voiceText="下次见" onClick={() => setShowAdmin(false)}>关闭</VoiceButton>
            </div>
            <div style={{ marginTop: 10, color: "#c9dcfb" }}>
              总用户: {adminData.stats?.totalUsers || 0} | 总对话: {adminData.stats?.totalConversations || 0} | 总消息: {adminData.stats?.totalMessages || 0} | 记忆备份: {adminData.stats?.totalMemoryBackups || 0}
            </div>
            <div className="card" style={{ padding: 10, marginTop: 12, display: "grid", gap: 8 }}>
              <div style={{ fontWeight: 700 }}>公告管理（对外展示）</div>
              <textarea
                className="input"
                style={{ minHeight: 96 }}
                value={announcementDraft}
                onChange={(e) => setAnnouncementDraft(e.target.value)}
                placeholder="编辑公告内容..."
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <VoiceButton className="btn secondary" voiceText="公告已保存" onClick={saveAnnouncement}>保存公告</VoiceButton>
                <VoiceButton className="btn secondary" voiceText="开始同步管理员历史数据" onClick={syncAdminMemories}>同步导入全站记忆到管理员</VoiceButton>
              </div>
            </div>
            <div className="scroll-y" style={{ maxHeight: 400, marginTop: 12, display: "grid", gap: 8 }}>
              {(adminData.users || []).map((user) => (
                <div key={user.user_id} className="card" style={{ padding: 10, display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <div>{user.email || "未知邮箱"}</div>
                    <div style={{ color: user.is_blocked ? "#ffb5b5" : "#a7c1e7", fontSize: 12 }}>
                      {user.is_blocked ? "已屏蔽" : "正常"}
                    </div>
                  </div>
                  <div style={{ color: "#a7c1e7", fontSize: 12 }}>
                    累计 token: {user.total_tokens} · 对话: {user.conversations} · 消息: {user.messages}
                  </div>
                  {user.is_blocked ? (
                    <div style={{ color: "#ffb5b5", fontSize: 12 }}>原因：{user.blocked_reason || "未填写"}</div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {user.is_blocked ? (
                      <VoiceButton className="btn secondary" onClick={() => toggleUserBlock(user.user_id, false)}>
                        解除屏蔽
                      </VoiceButton>
                    ) : (
                      <VoiceButton className="btn danger" onClick={() => toggleUserBlock(user.user_id, true, "违规内容/行为")}>
                        屏蔽用户
                      </VoiceButton>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="card" style={{ padding: 10, marginTop: 12, display: "grid", gap: 8 }}>
              <div style={{ fontWeight: 700 }}>全站最近对话记录（管理员可见）</div>
              <div className="scroll-y" style={{ maxHeight: 320, display: "grid", gap: 8 }}>
                {(adminData.conversations || []).map((item) => (
                  <div key={item.id} className="card" style={{ padding: 10 }}>
                    <div style={{ fontWeight: 700, color: "#d9e8ff" }}>{item.title}</div>
                    <div style={{ color: "#9cb9dc", fontSize: 12 }}>
                      用户: {item.email || item.user_id} · 更新时间: {formatTime(item.updated_at)}
                    </div>
                    <div style={{ color: "#dce9ff", fontSize: 13, whiteSpace: "pre-wrap", marginTop: 4 }}>
                      最新消息：{item.latest_message || "(空)"}
                    </div>
                  </div>
                ))}
                {(!adminData.conversations || adminData.conversations.length === 0) ? (
                  <div style={{ color: "#9bb3d4", fontSize: 13 }}>暂无对话记录。</div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showCommandCenter ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.62)", display: "grid", placeItems: "center", padding: 14, zIndex: 40 }} onClick={() => setShowCommandCenter(false)}>
          <div className="card command-center-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>操作指挥台</h3>
              <VoiceButton className="btn secondary" voiceText="下次见" onClick={() => setShowCommandCenter(false)}>关闭</VoiceButton>
            </div>
            <div className="command-center-grid">
              <VoiceButton className="btn secondary" onClick={() => { setInput("请先给一句结论，再给3条证据。"); setShowCommandCenter(false); }}>
                结论优先回答
              </VoiceButton>
              <VoiceButton className="btn secondary" onClick={() => { setInput("请将本次答案压缩成 120 字以内。"); setShowCommandCenter(false); }}>
                一键压缩答案
              </VoiceButton>
              <VoiceButton className="btn secondary" onClick={async () => { await loadQualityReview(); setMainView("quality"); setShowCommandCenter(false); }}>
                打开质量复盘
              </VoiceButton>
              <VoiceButton className="btn secondary" onClick={async () => { await loadWeeklyReport(); setMainView("weekly"); setShowCommandCenter(false); }}>
                打开效率周报
              </VoiceButton>
              <VoiceButton className="btn secondary" onClick={() => { setMainView("settings"); setShowCommandCenter(false); }}>
                打开设置页
              </VoiceButton>
              <VoiceButton
                className="btn secondary"
                onClick={() => {
                  if (!activeConversationId) {
                    void createConversation().catch((error) => showToast({ type: "error", text: String(error) }));
                  }
                  setHasEnteredWorkspace(true);
                  setShowCommandCenter(false);
                }}
              >
                新建并进入对话
              </VoiceButton>
            </div>
            <div className="command-center-tip">快捷键：按 <kbd>Ctrl</kbd> + <kbd>K</kbd> 随时呼出。</div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div
          style={{
            position: "fixed",
            right: 20,
            top: 20,
            zIndex: 60,
            background: toast.type === "success" ? "#153a2b" : "#452025",
            border: `1px solid ${toast.type === "success" ? "#2d8f67" : "#a25562"}`,
            color: "#f3fbff",
            borderRadius: 12,
            padding: "10px 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            boxShadow: "0 10px 24px rgba(0,0,0,0.35)",
          }}
        >
          {toast.type === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}




