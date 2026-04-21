import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { tts } from "edge-tts/out/index.js";

const schema = z.object({
  text: z.string().min(1).max(120),
  voice: z.enum(["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural"]).optional().default("zh-CN-XiaoxiaoNeural"),
});

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const { text, voice } = parsed.data;

  try {
    const audio = await tts(text, {
      voice,
      rate: "+8%",
      pitch: "+2Hz",
      volume: "+0%",
    });
    const bytes = audio instanceof Buffer ? audio : Buffer.from(audio);

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: `语音生成失败: ${String(error)}` }, { status: 502 });
  }
}
