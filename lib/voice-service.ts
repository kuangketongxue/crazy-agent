"use client";

export type VoiceProfile = {
  provider: "edge-tts";
  voice: "zh-CN-XiaoxiaoNeural" | "zh-CN-XiaoyiNeural";
};

export const VOICE_PROFILE: VoiceProfile = {
  provider: "edge-tts",
  voice: "zh-CN-XiaoxiaoNeural",
};

class VoiceBaseService {
  private enabled = true;
  private currentAudio: HTMLAudioElement | null = null;
  private currentAbort: AbortController | null = null;
  private cache = new Map<string, string>();
  private maxCache = 24;

  init() {
    // no-op: keep API consistent with previous implementation
  }

  setEnabled(next: boolean) {
    this.enabled = next;
    if (!next) {
      this.stop();
    }
  }

  setVoice(voice: "zh-CN-XiaoxiaoNeural" | "zh-CN-XiaoyiNeural") {
    VOICE_PROFILE.voice = voice;
  }

  private stop() {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
      this.currentAudio = null;
    }
  }

  private async getAudioUrl(text: string) {
    const key = `${VOICE_PROFILE.voice}::${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    this.currentAbort = new AbortController();
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: VOICE_PROFILE.voice }),
      signal: this.currentAbort.signal,
    });
    this.currentAbort = null;

    if (!response.ok) {
      throw new Error(`tts:${response.status}`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    this.cache.set(key, url);
    if (this.cache.size > this.maxCache) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) {
        const oldUrl = this.cache.get(oldest);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        this.cache.delete(oldest);
      }
    }

    return url;
  }

  async speak(text: string) {
    if (!this.enabled || typeof window === "undefined") return;
    const content = String(text || "").trim();
    if (!content) return;

    this.stop();

    try {
      const audioUrl = await this.getAudioUrl(content.slice(0, 120));
      const audio = new Audio(audioUrl);
      audio.preload = "auto";
      this.currentAudio = audio;
      await audio.play();
    } catch {
      // ignore voice failure, never block UI interaction
    }
  }
}

export const voiceService = new VoiceBaseService();
