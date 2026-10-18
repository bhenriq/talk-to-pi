import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TalkConfig } from "./config.ts";
import { readOpenRouterToken } from "./openrouter.ts";
import { refreshStatus, state } from "./state.ts";

// Preference order for `say` auto-voice selection.
const SAY_VOICE_PREFS = ["Samantha", "Flo", "Reed", "Shelley", "Sandy", "Eddy", "Ava", "Zoe", "Serena", "Daniel"];

// Friendly names → ElevenLabs voice ids (works through OpenRouter's /audio/speech).
const OPENROUTER_VOICES: Record<string, string> = {
  rachel: "21m00Tcm4TlvDq8ikWAM",
  sarah: "EXAVITQu4vr4xnSDxMaL",
  aria: "9BWtsMINqrJLrRacOk9x",
  adam: "pNInz6obpgDQGcFmaJgB",
  antoni: "ErXwobaYiN019PkySvjV",
  george: "JBFqnCBsd6RMkjVDRZzb",
};

export class Speaker {
  private queue: string[] = [];
  private current: AbortController | null = null;
  private draining = false;
  private sayVoice: string | null = null;
  private ttsDir = join(tmpdir(), "talk-to-pi", "tts");

  /** Called when a sentence actually starts playing (text is the spoken sentence). */
  onSpeak?: (text: string) => void;

  constructor(
    private pi: ExtensionAPI,
    private cfg: TalkConfig,
  ) {}

  private async resolveSayVoice(): Promise<string | null> {
    const v = this.cfg.tts.sayVoice;
    if (v !== "auto") return v;
    if (this.sayVoice !== null) return this.sayVoice || null;
    this.sayVoice = "";
    try {
      const res = await this.pi.exec("say", ["-v", "?"]);
      const tokens = res.stdout.split(/\s+/).filter(Boolean);
      for (const pref of SAY_VOICE_PREFS) {
        if (tokens.includes(pref)) {
          this.sayVoice = pref;
          break;
        }
      }
    } catch {
      this.sayVoice = "";
    }
    return this.sayVoice || null;
  }

  enqueue(text: string) {
    const t = text.trim();
    if (!t) return;
    this.queue.push(t);
    void this.drain();
  }

  /** Kill current speech and drop the queue. Speaker stays usable afterwards. */
  stop() {
    this.queue.length = 0;
    if (this.current) {
      this.current.abort();
      this.current = null;
    }
    state.speaking = false;
    refreshStatus();
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift()!;
        const controller = new AbortController();
        this.current = controller;
        state.speaking = true;
        refreshStatus();
        this.onSpeak?.(text);
        try {
          if (this.cfg.tts.provider === "openrouter") {
            await this.speakOpenRouter(text, controller);
          } else {
            await this.speakSay(text, controller);
          }
        } catch (err) {
          if (controller.signal.aborted) {
            // interrupted: stop cleanly, do not fall back
          } else if (this.cfg.tts.provider === "openrouter") {
            await this.speakSay(text, controller); // offline fallback
          }
        } finally {
          if (this.current === controller) this.current = null;
        }
        if (controller.signal.aborted) {
          // interrupt: stop draining the rest of the queue
          this.queue.length = 0;
          break;
        }
      }
    } finally {
      this.draining = false;
      state.speaking = false;
      refreshStatus();
    }
  }

  private openRouterVoiceId(): string {
    const v = this.cfg.tts.voice;
    if (!v || v === "auto") return OPENROUTER_VOICES.aria!;
    return OPENROUTER_VOICES[v] ?? v;
  }

  /** Synthesize via OpenRouter, write to a temp file and play it. Returns after playback. */
  private async speakOpenRouter(text: string, controller: AbortController): Promise<void> {
    const token = readOpenRouterToken();
    const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.cfg.tts.model,
        input: text,
        voice: this.openRouterVoiceId(),
        response_format: this.cfg.tts.format,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`TTS ${res.status}: ${detail}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("empty TTS response");

    mkdirSync(this.ttsDir, { recursive: true });
    const file = join(this.ttsDir, `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
    writeFileSync(file, buf);
    try {
      await this.playFile(file, controller);
    } finally {
      try {
        rmSync(file, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  private async speakSay(text: string, controller: AbortController): Promise<void> {
    const voice = await this.resolveSayVoice();
    if (!state.conference) {
      const args = voice ? ["-v", voice, text] : [text];
      await this.pi.exec(this.cfg.tts.command, args, { signal: controller.signal });
      return;
    }
    // Conference: render to AIFF, then play it into the conference output device.
    mkdirSync(this.ttsDir, { recursive: true });
    const file = join(this.ttsDir, `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.aiff`);
    const args = voice ? ["-v", voice, "-o", file, text] : ["-o", file, text];
    await this.pi.exec(this.cfg.tts.command, args, { signal: controller.signal });
    try {
      await this.playFile(file, controller);
    } finally {
      try {
        rmSync(file, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  /** Play an audio file to the right destination for the current mode. */
  private playFile(file: string, controller: AbortController): Promise<unknown> {
    if (state.conference) {
      // sox targets a named CoreAudio output device (the Multi-Output).
      return this.pi.exec("sox", [file, "-t", "coreaudio", this.cfg.conference.outputDevice], {
        signal: controller.signal,
      });
    }
    return this.pi.exec("afplay", [file], { signal: controller.signal });
  }
}