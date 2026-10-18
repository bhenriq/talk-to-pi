// talk-to-pi — hold space to talk, pi answers out loud.
// See SPEC.md for the full behaviour contract.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { BusyAudio } from "./src/busy-audio.ts";
import { loadConfig } from "./src/config.ts";
import { Listener } from "./src/listen.ts";
import { Recorder } from "./src/recorder.ts";
import { Relay } from "./src/relay.ts";
import { summarizeMeeting } from "./src/summary.ts";
import { getDefaultDevice, setDefaultDevice } from "./src/system-audio.ts";
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
  const listener = new Listener(cfg);
  speaker.onSpeak = (text) => {
    if (state.listenRecording) listener.addPiLine(text);
  };
  const relay = new Relay(cfg);
  let recorder: Recorder | null = null;
  let terminalUnsub: (() => void) | null = null;
  let lastReleaseAt = 0;
  let prevInputDevice: string | null = null;
  let prevOutputDevice: string | null = null;

  function setEnabled(on: boolean, ctx: ExtensionContext) {
    state.ctx = ctx;
    if (on === state.enabled) {
      refreshStatus();
      return;
    }
    state.enabled = on;
    if (on) {
      refreshStatus();
      ctx.ui.notify("Talk mode on — hold space to talk, Esc to interrupt", "info");
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
    // Conference toggle.
    if (matchesKey(data, cfg.input.conferenceShortcut)) {
      if (state.ctx) void toggleConference(state.ctx);
      return { consume: true };
    }
    // Listen toggle works regardless of talk mode.
    if (matchesKey(data, cfg.input.listenShortcut)) {
      if (state.ctx) void toggleListen(state.ctx);
      return { consume: true };
    }
    // Talk toggle.
    if (matchesKey(data, cfg.input.talkShortcut)) {
      if (state.ctx) setEnabled(!state.enabled, state.ctx);
      return { consume: true };
    }
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
      } else if (state.busy || state.speaking) {
        // Cut the AI short / interrupt speech (works even while the queued TTS is still reading).
        speaker.stop();
        if (state.busy) state.ctx?.abort();
      }
      // Idle: nothing — Esc never exits a mode; only /talk, /listen and the shortcuts toggle modes.
      return { consume: true };
    }

    // Space (talk key)
    if (state.transcribing) {
      return { consume: true }; // still submitting the last utterance
    }
    if (state.recording && recorder) {
      recorder.onSpaceEvent();
      return { consume: true };
    }
    if (state.busy || state.speaking) {
      // Barge-in: interrupt the AI and start listening again.
      speaker.stop();
      if (state.busy) state.ctx?.abort();
      startRecording();
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

  async function offerSaveTranscript(ctx: ExtensionContext) {
    const transcript = listener.transcriptText.trim();
    if (!transcript) return;
    const want = await ctx.ui.confirm(
      "Save meeting transcript?",
      `${listener.chunkCount} segments recorded. Save as Markdown with a summary at the top?`,
    );
    const rawPath = listener.filePath;
    if (!want) {
      ctx.ui.notify(`Raw transcript kept at ${rawPath}`, "info");
      return;
    }
    ctx.ui.notify("Summarizing meeting…", "info");
    try {
      const { slug, summary } = await summarizeMeeting(cfg, transcript);
      const dir = cfg.listen.outputDir.startsWith("~")
        ? join(homedir(), cfg.listen.outputDir.slice(1))
        : cfg.listen.outputDir;
      const date = new Date(listener.startTime || Date.now()).toISOString().slice(0, 10);
      let file = join(dir, `${date}-${slug}.md`);
      let i = 1;
      while (existsSync(file)) file = join(dir, `${date}-${slug}-${i++}.md`);
      writeFileSync(file, `# Meeting — ${slug}\n\n## Summary\n${summary}\n\n## Transcript\n${transcript}\n`);
      if (rawPath && rawPath !== file) {
        try {
          rmSync(rawPath, { force: true });
        } catch {
          // keep the raw copy if it cannot be removed
        }
      }
      ctx.ui.notify(`Transcript saved to ${file}`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Could not summarize (${msg}); raw transcript kept at ${rawPath}`, "warning");
    }
  }

  async function toggleListen(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Listen mode requires the interactive terminal", "error");
      return;
    }
    attach(ctx);
    if (state.listenRecording) {
      listener.stop();
      state.listenRecording = false;
      state.listenChunks = 0;
      refreshStatus();
      ctx.ui.notify(`Listening stopped — ${listener.chunkCount} segments transcribed`, "info");
      await offerSaveTranscript(ctx);
    } else {
      listener.start();
      state.listenRecording = true;
      refreshStatus();
      ctx.ui.notify("Listening started — transcribing the microphone", "info");
      if (state.conference) {
        ctx.ui.notify("Remote meeting audio is also being transcribed", "info");
        listener.setRemoteTap(cfg.conference.remoteTap);
      }
    }
  }

  async function restoreSystemDevices(ctx?: ExtensionContext) {
    try {
      if (prevOutputDevice) {
        await setDefaultDevice(pi, "output", prevOutputDevice);
        prevOutputDevice = null;
      }
      if (prevInputDevice) {
        await setDefaultDevice(pi, "input", prevInputDevice);
        prevInputDevice = null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx?.ui.notify(`Failed to restore system audio: ${msg}`, "warning");
    }
  }

  async function toggleConference(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Conference mode requires the interactive terminal", "error");
      return;
    }
    attach(ctx);
    state.conference = !state.conference;
    if (state.conference) {
      if (cfg.conference.relayMic) relay.start();
      listener.setRemoteTap(cfg.conference.remoteTap);
      refreshStatus();
      ctx.ui.notify("Conference mode on — pi's voice goes to you + the room", "info");
      if (cfg.conference.switchSystemDevices) {
        try {
          prevInputDevice = await getDefaultDevice(pi, "input");
          prevOutputDevice = await getDefaultDevice(pi, "output");
          await setDefaultDevice(pi, "input", cfg.conference.systemInputDevice);
          await setDefaultDevice(pi, "output", cfg.conference.systemOutputDevice);
          ctx.ui.notify("System audio switched for the call", "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`System audio switch failed: ${msg}`, "warning");
        }
      }
    } else {
      await restoreSystemDevices(ctx);
      relay.stop();
      listener.setRemoteTap(false);
      refreshStatus();
      ctx.ui.notify("Conference mode off", "info");
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────
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

  pi.registerCommand("listen", {
    description: "Start/stop recording the mic and transcribing it into context",
    handler: async (_args, ctx) => {
      await toggleListen(ctx);
    },
  });

  pi.registerCommand("conference", {
    description: "Route pi's voice to you and the meeting (Zoom mic = BlackHole)",
    handler: async (_args, ctx) => {
      await toggleConference(ctx);
    },
  });

  // ── Listen transcript tool ─────────────────────────────────────────────────
  pi.registerTool(
    defineTool({
      name: "listen_transcript",
      description:
        "Search the transcript recorded by /listen. Pass a word or phrase to find matching lines with timestamps, " +
        "or an empty string to see the most recent transcript. Use it whenever the user asks what was said.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Search term; empty for the most recent transcript" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const q = typeof (params as any)?.query === "string" ? (params as any).query : "";
        const text = listener.search(q);
        return { content: [{ type: "text", text }], details: { query: q } };
      },
    }),
  );

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  pi.on("session_start", (_ev, ctx) => {
    attach(ctx);
    listener.reset();
    relay.stop();
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

  pi.on("session_shutdown", async () => {
    recorder?.cancel();
    recorder = null;
    speaker.stop();
    listener.reset();
    relay.stop();
    await restoreSystemDevices();
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
    // Leave state.speaking alone: the Speaker owns it while the remaining queue plays.
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
    if (state.recording || state.transcribing) return; // never speak over the user's recording
    if ((ev.message as any)?.role === "assistant") {
      for (const s of speech.feed(assistantText(ev.message))) speaker.enqueue(s);
    }
  });

  pi.on("message_end", (ev, ctx) => {
    attach(ctx);
    if (!state.enabled) return;
    if (state.recording || state.transcribing) return; // never speak over the user's recording
    if ((ev.message as any)?.role === "assistant") {
      for (const s of speech.flush()) speaker.enqueue(s);
    }
  });

  // ── Context injection (voice nudge + listen transcript) ───────────────────
  pi.on("before_agent_start", (ev) => {
    if (state.enabled && cfg.promptNudge) {
      const guidelines = ev.systemPromptOptions?.promptGuidelines;
      if (Array.isArray(guidelines)) guidelines.push(VOICE_NUDGE);
    }
    const transcript = listener.transcriptText;
    if (transcript && transcript.trim()) {
      ev.systemPromptOptions.sections["listen_transcript"] =
        "A meeting is being (or was recently) recorded and transcribed from the microphone. " +
        "The most recent transcript follows (HH:MM:SS per line, oldest first). Use it to answer questions about " +
        "the meeting; for anything older than what is shown, call the listen_transcript tool.\n\n" +
        listener.recent(cfg.listen.contextWindowChars);
    }
  });
}