// talk-to-pi — hold space to talk, pi answers out loud.
// See SPEC.md for the full behaviour contract.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { BusyAudio } from "./src/busy-audio.ts";
import { loadConfig } from "./src/config.ts";
import { Recorder } from "./src/recorder.ts";
import { Speaker } from "./src/speaker.ts";
import { SpeechStream } from "./src/speech-stream.ts";
import { clearStatus, refreshStatus, resetState, setBusyAudio, state } from "./src/state.ts";
import { transcribeWav } from "./src/stt.ts";

const VOICE_NUDGE =
  "The user's messages may be transcribed from speech and your replies are read aloud by text-to-speech. " +
  "Lead with the answer, keep replies to 1-3 short sentences where possible, avoid headers, tables, bullet lists, " +
  "and markdown formatting, and avoid inline code unless specifically asked.";

function assistantText(message: unknown): string {
  const m = message as any;
  if (!m || m.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    let out = "";
    for (const c of m.content) {
      if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") out += c.text;
    }
    return out;
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const speaker = new Speaker(pi, cfg);
  const busyAudio = new BusyAudio(pi, cfg);
  setBusyAudio((active) => busyAudio.setActive(active));
  const speech = new SpeechStream();
  let recorder: Recorder | null = null;
  let terminalUnsub: (() => void) | null = null;
  let lastReleaseAt = 0;

  function setEnabled(on: boolean, ctx: ExtensionContext) {
    state.ctx = ctx;
    if (on === state.enabled) {
      refreshStatus();
      return;
    }
    state.enabled = on;
    if (on) {
      refreshStatus();
      ctx.ui.notify("Talk mode on — hold space to talk, Esc to stop", "info");
    } else {
      recorder?.cancel();
      recorder = null;
      speaker.stop();
      speech.reset();
      state.recording = false;
      state.transcribing = false;
      refreshStatus();
      ctx.ui.notify("Talk mode off", "info");
    }
  }

  function startRecording() {
    state.recording = true;
    refreshStatus();
    recorder = new Recorder(pi, cfg, {
      onCompleted: (wav) => {
        recorder = null;
        void finishRecording(wav);
      },
      onDiscarded: () => {
        state.recording = false;
        refreshStatus();
      },
    });
    recorder.start();
  }

  async function finishRecording(wav: string) {
    state.transcribing = true;
    refreshStatus();
    try {
      const text = await transcribeWav(pi, cfg, wav);
      state.transcribing = false;
      if (!text) {
        state.ctx?.ui.notify("No speech detected", "warning");
      } else {
        pi.sendUserMessage(text);
      }
    } catch (err) {
      state.transcribing = false;
      const msg = err instanceof Error ? err.message : String(err);
      state.ctx?.ui.notify(`Transcription failed: ${msg}`, "error");
    }
    refreshStatus();
  }

  function onTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (!state.enabled) return undefined;
    const isSpace = matchesKey(data, cfg.input.key);
    const isEsc = matchesKey(data, "escape");
    if (!isSpace && !isEsc) return undefined;

    if (isEsc) {
      if (state.recording && recorder) {
        recorder.cancel();
        recorder = null;
      } else if (state.transcribing) {
        // Ignore: transcription is already in flight.
      } else if (state.busy) {
        speaker.stop();
        state.ctx?.abort();
      } else {
        setEnabled(false, state.ctx!);
      }
      return { consume: true };
    }

    // Space (talk key)
    if (state.busy || state.transcribing) {
      return { consume: true }; // ignored while pi is working
    }
    if (state.recording && recorder) {
      recorder.onSpaceEvent();
      return { consume: true };
    }
    const now = Date.now();
    if (now - lastReleaseAt < cfg.input.debounceMs) {
      return { consume: true }; // debounce the tail of a recent release
    }
    startRecording();
    return { consume: true };
  }

  function attach(ctx: ExtensionContext) {
    state.ctx = ctx;
  }

  // ── Command ────────────────────────────────────────────────────────────────
  pi.registerCommand("talk", {
    description: "Toggle voice mode: hold space to talk, pi answers out loud",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Talk mode requires the interactive terminal", "error");
        return;
      }
      setEnabled(!state.enabled, ctx);
    },
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  pi.on("session_start", (_ev, ctx) => {
    attach(ctx);
    resetState();
    lastReleaseAt = 0;
    recorder?.cancel();
    recorder = null;
    speaker.stop();
    speech.reset();
    if (ctx.mode === "tui") {
      terminalUnsub?.();
      terminalUnsub = ctx.ui.onTerminalInput((data) => onTerminalInput(data));
    }
    refreshStatus();
  });

  pi.on("session_shutdown", () => {
    recorder?.cancel();
    recorder = null;
    speaker.stop();
    terminalUnsub?.();
    terminalUnsub = null;
    clearStatus();
    resetState();
  });

  pi.on("agent_start", (_ev, ctx) => {
    attach(ctx);
    state.busy = true;
    state.speaking = false;
    speaker.stop(); // drop any stale speech from a previous run
    speech.reset();
    refreshStatus();
  });

  pi.on("agent_end", (_ev, ctx) => {
    attach(ctx);
    state.busy = false;
    refreshStatus();
  });

  pi.on("agent_settled", (_ev, ctx) => {
    attach(ctx);
    state.busy = false;
    state.speaking = false;
    refreshStatus();
  });

  // ── Streaming speech ────────────────────────────────────────────────────────
  pi.on("message_start", (ev, ctx) => {
    attach(ctx);
    if ((ev.message as any)?.role === "assistant") speech.reset();
  });

  pi.on("message_update", (ev, ctx) => {
    attach(ctx);
    if (!state.enabled) return;
    if ((ev.message as any)?.role === "assistant") {
      for (const s of speech.feed(assistantText(ev.message))) speaker.enqueue(s);
    }
  });

  pi.on("message_end", (ev, ctx) => {
    attach(ctx);
    if (!state.enabled) return;
    if ((ev.message as any)?.role === "assistant") {
      for (const s of speech.flush()) speaker.enqueue(s);
    }
  });

  // ── Voice-style prompt nudge ────────────────────────────────────────────────
  pi.on("before_agent_start", (ev) => {
    if (!state.enabled || !cfg.promptNudge) return;
    const guidelines = ev.systemPromptOptions?.promptGuidelines;
    if (Array.isArray(guidelines)) guidelines.push(VOICE_NUDGE);
  });
}