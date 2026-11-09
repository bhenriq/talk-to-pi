import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Defaults shipped with the package (also the dev config when editing a clone). */
const PACKAGE_CONFIG_PATH = join(__dirname, "..", "config.json");
/** Per-user overrides; survives package updates (`pi install` resets the clone). */
const USER_CONFIG_PATH = join(homedir(), ".pi", "agent", "talk-to-pi.json");

export interface ConferenceOutputs {
  /** Where pi's TTS plays so both you and the room hear it (a Multi-Output). */
  voiceDevice: string;
  /** System default output while conference is on (call audio → you + remote tap). */
  systemOutputDevice: string;
}

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
    /** macOS virtual keycode for `key` (61 = right option). */
    keyCode: number;
    /**
     * Bundle ids of the apps where the native talk key counts as "focused" (your
     * terminal(s)). Holding the talk key while another app is frontmost is ignored.
     */
    talkTerminalApps: string[];
    /** Keyboard shortcut to open the voice & speed menu. */
    voiceShortcut: string;
    /** Keyboard shortcut to show/hide the live transcript widget. */
    transcriptShortcut: string;
    /** The microphone always used for talk and /listen (never the headset mic). */
    micDevice: string;
    pollMs: number;
    /** Unused (kept for backward compatibility). */
    repeatSilenceMs: number;
    /** Ignore a talk-key press this soon after a release. */
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
     * Device watched for the "headset connected" indicator while a voice mode is
     * on. Empty disables the watch (no probing, no footer item).
     */
    headsetDevice: string;
    /** Built-in speakers used for local playback when the headset is off (empty = system default). */
    localSpeaker: string;
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
    /** Max verbatim transcript chars accumulated in context before they are collapsed into a recap. */
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
  say: {
    /**
     * How `/say <message>` behaves:
     * - `auto` speaks the reply as soon as it streams (default)
     * - `approval` shows the reply and waits for Enter before speaking
     */
    mode: "auto" | "approval";
  };
  conference: {
    /** Virtual device whose input Zoom uses as its microphone (BlackHole 2ch). */
    roomDevice: string;
    /** Virtual device that taps the meeting audio into /listen (BlackHole 16ch). */
    remoteTapDevice: string;
    /** Relay your mic into the room while conference mode is on. */
    relayMic: boolean;
    /** Linear gain applied to your relayed mic signal (1 = unchanged). */
    micGain: number;
    /** Linear gain applied to pi's voice in the room (1 = unchanged). */
    ttsGain: number;
    /** Feed remote meeting audio into /listen while conference mode is on. */
    remoteTap: boolean;
    /** Silence the busy cue entirely while conference mode is on (false by default: it plays into the room like pi's voice). */
    muteBusyCue: boolean;
    /** While on, switch the system default input to this device (BlackHole 2ch, both columns). */
    systemInputDevice: string;
    /** Auto-switch the system default input/output on enter, restore on exit. */
    switchSystemDevices: boolean;
    /** Output devices for the headset-connected column. */
    headset: ConferenceOutputs;
    /** Output devices for the headset-off (built-in speakers) column. */
    builtin: ConferenceOutputs;
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
  input: {
    key: "f5",
    keyCode: 96,
    talkTerminalApps: [
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "net.kovidgoyal.kitty",
      "org.alacritty",
      "dev.warp.Warp-Stable",
      "co.zeit.hyper",
      "com.microsoft.VSCode",
      "com.github.wez.wezterm",
    ],
    voiceShortcut: "ctrl+shift+o",
    transcriptShortcut: "ctrl+shift+m",
    micDevice: "MacBook Pro Microphone",
    pollMs: 25,
    repeatSilenceMs: 150,
    debounceMs: 250,
    minRecordingMs: 400,
  },
  promptNudge: true,
  audio: { processingCue: true, volume: 0.4, intervalMs: 650, headsetDevice: "", localSpeaker: "" },
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
  say: { mode: "auto" },
  conference: {
    roomDevice: "BlackHole 2ch",
    remoteTapDevice: "BlackHole 16ch",
    relayMic: true,
    micGain: 1.0,
    ttsGain: 1.0,
    remoteTap: true,
    muteBusyCue: false,
    systemInputDevice: "BlackHole 2ch",
    switchSystemDevices: true,
    headset: {
      voiceDevice: "Pi Talks (headset)",
      systemOutputDevice: "Pi Listens (headset)",
    },
    builtin: {
      voiceDevice: "Pi Talks (speaker)",
      systemOutputDevice: "Pi Listens (speaker)",
    },
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

export function conferenceColumn(cfg: TalkConfig, headsetOn: boolean): ConferenceOutputs {
  return headsetOn ? cfg.conference.headset : cfg.conference.builtin;
}

/**
 * Local playback target: the headset when it is connected, the built-in speakers
 * when it is known to be off, and "" (system default) when the state is unknown.
 * Empty string means "play to the macOS system default" (afplay).
 */
export function localPlaybackDevice(cfg: TalkConfig, headset: boolean | null): string {
  if (headset === true) return cfg.audio.headsetDevice;
  if (headset === false) return cfg.audio.localSpeaker;
  return "";
}

function readConfigObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable files are not fatal: fall back to the next layer.
  }
  return undefined;
}

/**
 * Where edits and `/say` mode changes are written: `TALK_TO_PI_CONFIG` when set,
 * otherwise `~/.pi/agent/talk-to-pi.json`. Never the package clone, which
 * `pi update --extensions` resets.
 */
function writableConfigPath(): string {
  const explicit = process.env.TALK_TO_PI_CONFIG?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  return USER_CONFIG_PATH;
}

/** Built-in defaults → shipped config.json → the user's overrides. */
function configPaths(): string[] {
  const user = writableConfigPath();
  return user === PACKAGE_CONFIG_PATH ? [PACKAGE_CONFIG_PATH] : [PACKAGE_CONFIG_PATH, user];
}

export function loadConfig(): TalkConfig {
  let cfg = JSON.parse(JSON.stringify(DEFAULTS)) as Record<string, unknown>;
  for (const path of configPaths()) {
    const raw = readConfigObject(path);
    if (raw) cfg = merge(cfg, raw);
  }
  return cfg as unknown as TalkConfig;
}

/** Persist a new `/say` mode to the user config and return true on success. */
export function saveSayMode(mode: "auto" | "approval"): boolean {
  try {
    const data = loadConfig() as unknown as Record<string, unknown>;
    data.say = { ...(data.say as Record<string, unknown>), mode };
    const path = writableConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}