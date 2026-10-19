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
    /** Default speaking speed multiplier. */
    speed: number;
    model: string;
    format: "mp3" | "pcm";
  };
  input: {
    key: string;
    /** Keyboard shortcut to toggle /listen (start/stop mic transcription). */
    listenShortcut: string;
    /** Keyboard shortcut to toggle /talk mode. */
    talkShortcut: string;
    /** Keyboard shortcut to toggle /conference mode. */
    conferenceShortcut: string;
    /** Keyboard shortcut to open the voice & speed menu. */
    voiceShortcut: string;
    /** The microphone always used for talk and /listen (never the headset mic). */
    micDevice: string;
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
    /**
     * Private output device for the cue while conference mode is on, so you hear
     * it but neither BlackHole tap picks it up. Empty = no private route.
     */
    cueDevice: string;
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
    /** Model used to summarize the meeting and pick a filename slug on save. */
    summaryModel: string;
    /**
     * What `/listen` leaves in the conversation when it stops, so the discussion
     * stays usable after the fact:
     * - `summary` keeps a short LLM-written recap plus the file path (cheap)
     * - `full` keeps the whole transcript in context (accurate, token-heavy)
     * - `none` keeps nothing in context; the file stays on disk
     */
    contextMode: "summary" | "full" | "none";
  };
  conference: {
    /** Where pi's TTS is played so both you and the room hear it (Multi-Output). */
    outputDevice: string;
    /** Virtual device whose input Zoom uses as its microphone (BlackHole 2ch). */
    roomDevice: string;
    /** Virtual device that taps the meeting audio into /listen (BlackHole 16ch). */
    remoteTapDevice: string;
    /** Relay your mic into the room while conference mode is on. */
    relayMic: boolean;
    /** Feed remote meeting audio into /listen while conference mode is on. */
    remoteTap: boolean;
    /** Silence the busy cue so the room never hears it. */
    muteBusyCue: boolean;
    /** While on, switch the system default input to this device. */
    systemInputDevice: string;
    /** While on, switch the system default output to this device. */
    systemOutputDevice: string;
    /** Auto-switch the system default input/output on enter, restore on exit. */
    switchSystemDevices: boolean;
  };
}

const DEFAULTS: TalkConfig = {
  stt: { model: "mistralai/voxtral-small-24b-2507", sampleRate: 16000, channels: 1, bits: 16 },
  tts: {
    provider: "openrouter",
    command: "say",
    sayVoice: "auto",
    voice: "rachel",
    speed: 1.0,
    model: "elevenlabs/eleven-flash-v2.5",
    format: "mp3",
  },
  input: { key: "space", listenShortcut: "ctrl+shift+l", talkShortcut: "ctrl+shift+t", conferenceShortcut: "ctrl+shift+c", voiceShortcut: "ctrl+shift+o", micDevice: "MacBook Pro Microphone", keyCode: 49, pollMs: 25, repeatSilenceMs: 150, debounceMs: 250, minRecordingMs: 400 },
  promptNudge: true,
  audio: { processingCue: true, volume: 0.4, intervalMs: 650, cueDevice: "" },
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
    summaryModel: "deepseek/deepseek-chat",
    contextMode: "summary",
  },
  conference: {
    outputDevice: "Pi Talks (Zoom mic)",
    roomDevice: "BlackHole 2ch",
    remoteTapDevice: "BlackHole 16ch",
    relayMic: true,
    remoteTap: true,
    muteBusyCue: true,
    systemInputDevice: "BlackHole 2ch",
    systemOutputDevice: "Pi Listens (Zoom speaker)",
    switchSystemDevices: true,
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