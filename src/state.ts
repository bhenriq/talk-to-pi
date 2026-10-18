import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TalkPhase = "off" | "idle" | "recording" | "transcribing" | "speaking" | "thinking";

export const state = {
  ctx: null as ExtensionContext | null,
  enabled: false,
  busy: false,
  speaking: false,
  recording: false,
  transcribing: false,
};

// Voice-wave animation frames shown while waiting (transcribing or thinking).
const WAVE_FRAMES = [
  "▁▁▁▁",
  "▂▁▁▁",
  "▃▂▁▁",
  "▄▃▂▁",
  "▅▄▃▂",
  "▆▅▄▃",
  "▇▆▅▄",
  "▆▅▄▃",
  "▅▄▃▂",
  "▄▃▂▁",
  "▃▂▁▁",
  "▂▁▁▁",
];

const ANIM_INTERVAL_MS = 120;

let animTimer: ReturnType<typeof setInterval> | null = null;
let animStep = 0;
let busyAudioCb: ((active: boolean) => void) | null = null;

/** Wire the audible busy cue into the wait window (set by index.ts). */
export function setBusyAudio(cb: (active: boolean) => void) {
  busyAudioCb = cb;
}

export function resetState() {
  stopAnimation();
  state.enabled = false;
  state.busy = false;
  state.speaking = false;
  state.recording = false;
  state.transcribing = false;
}

/** Waiting = between releasing the talk key and pi starting to speak back. */
export function isWaiting(): boolean {
  return state.enabled && (state.transcribing || (state.busy && !state.speaking));
}

function ensureAnimation() {
  if (isWaiting()) {
    if (!animTimer) {
      animTimer = setInterval(() => {
        animStep = (animStep + 1) % WAVE_FRAMES.length;
        refreshStatus();
      }, ANIM_INTERVAL_MS);
    }
    busyAudioCb?.(true);
  } else {
    stopAnimation();
  }
}

function stopAnimation() {
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
  animStep = 0;
  busyAudioCb?.(false);
}

export function phase(): TalkPhase {
  if (!state.enabled) return "off";
  if (state.recording) return "recording";
  if (state.transcribing) return "transcribing";
  if (state.busy && state.speaking) return "speaking";
  if (state.busy) return "thinking";
  return "idle";
}

function currentLabel(): string | undefined {
  if (!state.enabled) return undefined;
  if (state.recording) return "🎙 listening";
  if (state.transcribing) return `🎙 transcribing ${WAVE_FRAMES[animStep]}`;
  if (state.busy && state.speaking) return "🔊 speaking";
  if (state.busy) return `🧠 thinking ${WAVE_FRAMES[animStep]}`;
  return "🎙 talk: idle";
}

export function refreshStatus() {
  ensureAnimation();
  state.ctx?.ui.setStatus("talk-to-pi", currentLabel());
}

export function clearStatus() {
  stopAnimation();
  state.ctx?.ui.setStatus("talk-to-pi", undefined);
}