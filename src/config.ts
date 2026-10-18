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
    /** Keyboard shortcut to toggle /listen (start/stop mic transcription). */
    listenShortcut: string;
    /** Keyboard shortcut to toggle /talk mode. */
    talkShortcut: string;
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
  listen: {
    model: string;
    sampleRate: number;
    channels: number;
    bits: number;
    chunkSeconds: number;
    skipSilence: boolean;
    /** RMS threshold (0..1) below which a chunk is treated as silence and skipped. */
    silenceThreshold: number;
    /** Directory for persisted transcripts. `~` expands to the home directory. */
    outputDir: string;
    /** How much of the recent transcript to inject into the system prompt. */
    contextWindowChars: number;
    /** How many recent transcript lines to show in the live footer widget (max 10). */
    widgetLines: number;
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
  input: { key: "space", listenShortcut: "ctrl+shift+l", talkShortcut: "ctrl+shift+t", keyCode: 49, pollMs: 25, repeatSilenceMs: 150, debounceMs: 250, minRecordingMs: 400 },
  promptNudge: true,
  audio: { processingCue: true, volume: 0.4, intervalMs: 650 },
  listen: {
    model: "deepgram/nova-3",
    sampleRate: 16000,
    channels: 1,
    bits: 16,
    chunkSeconds: 5,
    skipSilence: true,
    silenceThreshold: 0.005,
    outputDir: "~/.pi/listen",
    contextWindowChars: 6000,
    widgetLines: 8,
  },
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