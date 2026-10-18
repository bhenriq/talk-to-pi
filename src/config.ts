import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TalkConfig {
  stt: {
    model: string;
    sampleRate: number;
    channels: number;
    bits: number;
  };
  tts: {
    /** "say" (offline) or "openrouter" (cloud). */
    provider: "say" | "openrouter";
    command: string;
    /** Voice name for the `say` provider ("auto" picks the best installed). */
    sayVoice: string;
    /** Voice name or ElevenLabs voice id for the `openrouter` provider. */
    voice: string;
    model: string;
    format: "mp3" | "pcm";
  };
  input: {
    key: string;
    /** macOS virtual keycode: 49 = space. */
    keyCode: number;
    pollMs: number;
    /** Autorepeat fallback: silence after the last repeat counts as release. */
    repeatSilenceMs: number;
    /** Ignore a space press this soon after a release. */
    debounceMs: number;
    /** Recordings shorter than this are discarded. */
    minRecordingMs: number;
  };
  /** Append a voice-style nudge to the system prompt while talk mode is on. */
  promptNudge: boolean;
  audio: {
    /** Play a soft audible cue while waiting (transcribing/thinking). */
    processingCue: boolean;
    /** afplay volume for the cue, 0..1. */
    volume: number;
    /** Pause between cue notes, in ms. */
    intervalMs: number;
  };
}

const DEFAULTS: TalkConfig = {
  stt: { model: "mistralai/voxtral-small-24b-2507", sampleRate: 16000, channels: 1, bits: 16 },
  tts: {
    provider: "openrouter",
    command: "say",
    sayVoice: "auto",
    voice: "aria",
    model: "elevenlabs/eleven-flash-v2.5",
    format: "mp3",
  },
  input: { key: "space", keyCode: 49, pollMs: 25, repeatSilenceMs: 150, debounceMs: 250, minRecordingMs: 400 },
  promptNudge: true,
  audio: { processingCue: true, volume: 0.4, intervalMs: 650 },
};

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(over)) {
    const v = over[k];
    const b = base[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = merge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(): TalkConfig {
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf8"));
    return merge(DEFAULTS as unknown as Record<string, unknown>, raw) as unknown as TalkConfig;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS)) as TalkConfig;
  }
}