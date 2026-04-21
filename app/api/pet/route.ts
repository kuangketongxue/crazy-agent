import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";

const schema = z.object({
  action: z.enum(["thinking", "answered", "idle", "play", "rest"]),
});
const profileSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

type PetAttributes = {
  debugging: number;
  patience: number;
  chaos: number;
  wisdom: number;
  snark: number;
};

type PetRow = {
  species: string;
  name: string;
  mood: string;
  energy: number;
  rarity: string;
  trait_focus: keyof PetAttributes;
  trait_weakness: keyof PetAttributes;
  attributes: PetAttributes;
  level: number;
  xp: number;
  last_interacted_at?: string | null;
  updated_at?: string | null;
};

const PETS: Record<string, { emoji: string; trait: string }> = {
  cat: { emoji: "\uD83D\uDC31", trait: "专注与独立" },
  dog: { emoji: "\uD83D\uDC36", trait: "热情与执行力" },
  fox: { emoji: "\uD83E\uDD8A", trait: "灵活与策略" },
  rabbit: { emoji: "\uD83D\uDC30", trait: "敏捷与学习力" },
  otter: { emoji: "\uD83E\uDDA6", trait: "好奇与创造力" },
};

const rarityBase: Record<string, number> = {
  common: 40,
  uncommon: 48,
  rare: 55,
  epic: 62,
  legendary: 72,
};

function clamp(v: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function toAttributes(value: unknown): PetAttributes {
  if (!value || typeof value !== "object") {
    return { debugging: 55, patience: 50, chaos: 40, wisdom: 58, snark: 35 };
  }
  const src = value as Partial<PetAttributes>;
  return {
    debugging: clamp(Number(src.debugging ?? 55)),
    patience: clamp(Number(src.patience ?? 50)),
    chaos: clamp(Number(src.chaos ?? 40)),
    wisdom: clamp(Number(src.wisdom ?? 58)),
    snark: clamp(Number(src.snark ?? 35)),
  };
}

function buildDefaultPet(): Omit<PetRow, "species" | "name" | "mood" | "energy"> {
  const rarity = "rare";
  const base = rarityBase[rarity];
  return {
    rarity,
    trait_focus: "wisdom",
    trait_weakness: "snark",
    attributes: {
      debugging: base + 2,
      patience: base - 3,
      chaos: base - 10,
      wisdom: base + 4,
      snark: base - 14,
    },
    level: 1,
    xp: 0,
  };
}

function xpNeedForLevel(level: number) {
  return 60 + Math.max(1, level) * 24;
}

function evolve(
  action: "thinking" | "answered" | "idle" | "play" | "rest",
  currentEnergy: number,
  attrs: PetAttributes,
  level: number,
  xp: number,
  focus: keyof PetAttributes,
): { mood: string; energy: number; attributes: PetAttributes; level: number; xp: number } {
  const nextAttrs = { ...attrs };
  let mood = "idle";
  let energy = currentEnergy;
  let gainXp = 4;

  if (action === "thinking") {
    mood = "thinking";
    gainXp = 8;
    energy = clamp(currentEnergy - 2);
    nextAttrs.debugging = clamp(nextAttrs.debugging + 1);
    nextAttrs.wisdom = clamp(nextAttrs.wisdom + 1);
    nextAttrs.patience = clamp(nextAttrs.patience + 1);
  } else if (action === "answered") {
    mood = "happy";
    gainXp = 12;
    energy = clamp(currentEnergy - 1);
    nextAttrs.wisdom = clamp(nextAttrs.wisdom + 1);
    nextAttrs.snark = clamp(nextAttrs.snark - 1);
  } else if (action === "play") {
    mood = "playful";
    gainXp = 10;
    energy = clamp(currentEnergy - 6);
    nextAttrs.chaos = clamp(nextAttrs.chaos + 1);
  } else if (action === "rest") {
    mood = "resting";
    gainXp = 6;
    energy = clamp(currentEnergy + 10);
    nextAttrs.patience = clamp(nextAttrs.patience + 1);
    nextAttrs.chaos = clamp(nextAttrs.chaos - 1);
  } else {
    mood = "idle";
    gainXp = 5;
    energy = clamp(currentEnergy + 2);
    nextAttrs.wisdom = clamp(nextAttrs.wisdom + 1);
  }

  let nextLevel = Math.max(1, level || 1);
  let nextXp = Math.max(0, xp || 0) + gainXp;
  while (nextXp >= xpNeedForLevel(nextLevel) && nextLevel < 50) {
    nextXp -= xpNeedForLevel(nextLevel);
    nextLevel += 1;
    nextAttrs[focus] = clamp(nextAttrs[focus] + 2);
    nextAttrs.debugging = clamp(nextAttrs.debugging + 1);
    nextAttrs.wisdom = clamp(nextAttrs.wisdom + 1);
  }

  return { mood, energy, attributes: nextAttrs, level: nextLevel, xp: nextXp };
}

function decorate(row: PetRow) {
  const meta = PETS[row.species] || PETS.cat;
  return {
    ...row,
    emoji: meta.emoji,
    trait: meta.trait,
    xpToNext: xpNeedForLevel(Math.max(1, Number(row.level || 1))),
  };
}

async function getOrCreate(userId: string) {
  await db.query(`INSERT INTO user_pet_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const defaults = buildDefaultPet();
  const { rows } = await db.query(
    `
      UPDATE user_pet_state
      SET
        rarity = COALESCE(rarity, $2),
        trait_focus = COALESCE(trait_focus, $3),
        trait_weakness = COALESCE(trait_weakness, $4),
        attributes = COALESCE(attributes, $5::jsonb),
        level = COALESCE(level, 1),
        xp = COALESCE(xp, 0)
      WHERE user_id = $1
      RETURNING species, name, mood, energy, rarity, trait_focus, trait_weakness, attributes, level, xp, last_interacted_at, updated_at
    `,
    [
      userId,
      defaults.rarity,
      defaults.trait_focus,
      defaults.trait_weakness,
      JSON.stringify(defaults.attributes),
    ],
  );
  const row = rows[0];
  return {
    ...row,
    energy: Number(row.energy ?? 80),
    level: Math.max(1, Number(row.level ?? 1)),
    xp: Math.max(0, Number(row.xp ?? 0)),
    attributes: toAttributes(row.attributes),
  } as PetRow;
}

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const pet = await getOrCreate(user.userId);
  return NextResponse.json({ pet: decorate(pet) });
}

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const current = await getOrCreate(user.userId);

  const next = evolve(
    parsed.data.action,
    Number(current.energy || 80),
    toAttributes(current.attributes),
    Number(current.level || 1),
    Number(current.xp || 0),
    current.trait_focus || "wisdom",
  );

  const { rows } = await db.query(
    `
      UPDATE user_pet_state
      SET mood = $2, energy = $3, attributes = $4::jsonb, level = $5, xp = $6, last_interacted_at = now(), updated_at = now()
      WHERE user_id = $1
      RETURNING species, name, mood, energy, rarity, trait_focus, trait_weakness, attributes, level, xp, last_interacted_at, updated_at
    `,
    [user.userId, next.mood, next.energy, JSON.stringify(next.attributes), next.level, next.xp],
  );

  const updated = rows[0] || { ...current, ...next };
  return NextResponse.json({
    pet: decorate({
      ...updated,
      energy: Number(updated.energy ?? next.energy),
      level: Math.max(1, Number(updated.level ?? next.level)),
      xp: Math.max(0, Number(updated.xp ?? next.xp)),
      attributes: toAttributes(updated.attributes ?? next.attributes),
    } as PetRow),
  });
}

export async function PUT(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const parsed = profileSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  await getOrCreate(user.userId);
  const { rows } = await db.query(
    `
      UPDATE user_pet_state
      SET name = $2, updated_at = now()
      WHERE user_id = $1
      RETURNING species, name, mood, energy, rarity, trait_focus, trait_weakness, attributes, level, xp, last_interacted_at, updated_at
    `,
    [user.userId, parsed.data.name],
  );
  const row = rows[0];
  return NextResponse.json({
    pet: decorate({
      ...row,
      energy: Number(row.energy ?? 80),
      level: Math.max(1, Number(row.level ?? 1)),
      xp: Math.max(0, Number(row.xp ?? 0)),
      attributes: toAttributes(row.attributes),
    } as PetRow),
  });
}


