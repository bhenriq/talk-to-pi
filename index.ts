// talk-to-pi — hold the talk key to speak, pi answers out loud.
// See SPEC.md for the full behaviour contract.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { BusyAudio } from "./src/busy-audio.ts";
import { HeadsetWatch } from "./src/headset.ts";
import { getKeyWatcherBinary, watchKey, type KeyWatcher } from "./src/keywatch.ts";
import { conferenceColumn, loadConfig, localPlaybackDevice, saveSayMode } from "./src/config.ts";
import { Listener } from "./src/listen.ts";
import { Recorder } from "./src/recorder.ts";
import { Relay } from "./src/relay.ts";
import { summarizeMeeting } from "./src/summary.ts";
import { getDefaultDevice, probeDevice, setDefaultDevice } from "./src/system-audio.ts";
import { VoiceMenu } from "./src/voice-menu.ts";
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

/** Human-friendly talk-key label for notifications. */
function displayKey(key: string): string {
  const pretty: Record<string, string> = {
    space: "Space",
    escape: "Esc",
    "right-option": "Right ⌥",
    "right-alt": "Right ⌥",
    "right-command": "Right ⌘",
    "right-cmd": "Right ⌘",
  };
  if (pretty[key]) return pretty[key];
  return /^f\d+$/i.test(key) ? key.toUpperCase() : key;
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const speaker = new Speaker(pi, cfg);
  const busyAudio = new BusyAudio(pi, cfg);
  setBusyAudio((active) => busyAudio.setActive(active));
  const headset = new HeadsetWatch(pi, cfg, (connected) => onHeadsetChanged(connected));
  const speech = new SpeechStream();
  const sayStream = new SpeechStream(); // collects text for approval-mode /say
  const listener = new Listener(cfg);
  speaker.onSpeak = (text) => {
    if (state.listenRecording) listener.addPiLine(text);
  };
  const relay = new Relay(cfg);
  let recorder: Recorder | null = null;
  let terminalUnsub: (() => void) | null = null;
  let lastReleaseAt = 0;
  let prevOutputDevice: string | null = null;
  let menuOpen = false;
  /** Active /say mode for the current turn (false outside /say turns). */
  let sayMode: false | "auto" | "approval" = false;
  /** A /say was typed while pi was busy; arm on the next turn instead. */
  let pendingSay: false | "auto" | "approval" = false;
  /** Collected speech text for an approval-mode /say turn. */
  let sayQueue: string[] = [];
  let talkKeyWatcher: KeyWatcher | null = null;

  /** Warn when the talk key is an F-key but macOS is still in media-key mode. */
  async function warnFnKeys(ctx: ExtensionContext) {
    try {
      const res = await pi.exec("defaults", ["read", "-g", "com.apple.keyboard.fnState"]);
      if (String(res.stdout).trim() !== "1") {
        ctx.ui.notify(
          "F-keys are set to media actions — turn on 'Use F1, F2, etc. keys as standard function keys' (System Settings → Keyboard → Keyboard Shortcuts… → Function Keys), or the talk key won't be detected",
          "warning",
        );
      }
    } catch {
      // Setting is unset in some environments; the watcher simply won't see F-key presses.
    }
  }

  function setEnabled(on: boolean, ctx: ExtensionContext) {
    state.ctx = ctx;
    if (on === state.enabled) {
      refreshStatus();
      return;
    }
    state.enabled = on;
    if (on) {
      refreshStatus();
      startTalkKeyWatcher();
      if (/^f\d+$/i.test(cfg.input.key)) void warnFnKeys(ctx);
      ctx.ui.notify(`Talk mode on — hold ${displayKey(cfg.input.key)} to talk, Esc to interrupt`, "info");
    } else {
      stopTalkKeyWatcher();
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

  // ── Talk-key watcher (native poll, with a frontmost-app guard) ───────────
  // The talk key is read directly from macOS key state, so a bare modifier like
  // Right ⌥ works and Space stays free for typing. Down starts a recording, up
  // releases it; the helper only reports down while a configured terminal app is
  // frontmost so holding the key in another app does nothing.

  function startTalkKeyWatcher() {
    if (talkKeyWatcher) return;
    const bin = getKeyWatcherBinary();
    if (!bin) {
      state.ctx?.ui.notify("Talk-key watcher unavailable — push-to-talk won't work", "error");
      return;
    }
    talkKeyWatcher = watchKey(
      bin,
      cfg.input.keyCode,
      cfg.input.pollMs,
      cfg.input.talkTerminalApps,
      (down) => {
        if (down) handleTalkKeyDown();
        else handleTalkKeyUp();
      },
    );
  }

  function stopTalkKeyWatcher() {
    talkKeyWatcher?.stop();
    talkKeyWatcher = null;
  }

  function handleTalkKeyDown() {
    if (!state.enabled || menuOpen) return;
    if (state.recording || state.transcribing) return;
    if (state.busy || state.speaking) {
      // Barge-in: interrupt pi and start listening immediately.
      speaker.stop();
      if (state.busy) state.ctx?.abort();
      startRecording();
      return;
    }
    if (Date.now() - lastReleaseAt < cfg.input.debounceMs) return; // tail of a recent release
    startRecording();
  }

  function handleTalkKeyUp() {
    if (state.recording && recorder) {
      recorder.release();
      lastReleaseAt = Date.now();
    }
  }

  async function approveSay(ctx: ExtensionContext, sentences: string[]) {
    const preview = sentences.join(" ").replace(/\s+/g, " ").trim();
    if (!preview) return;
    const ok = await ctx.ui.confirm("Hear pi's answer? (Enter to speak, Esc to skip)", preview);
    if (ok) {
      for (const s of sentences) speaker.enqueue(s);
    } else {
      ctx.ui.notify("Skipped — answer not spoken", "info");
    }
  }

  function openVoiceMenu(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Voice menu requires the interactive terminal", "error");
      return;
    }
    menuOpen = true;
    void ctx.ui
      .custom(
        (tui, _theme, _kb, done) =>
          new VoiceMenu(
            tui,
            speaker,
            () => done(undefined),
            (m) => ctx.ui.notify(m, "info"),
            cfg.say.mode,
            (mode) => {
              cfg.say.mode = mode;
              saveSayMode(mode);
            },
          ),
        { overlay: true, overlayOptions: { width: "44%", anchor: "center", margin: { top: 2 } } },
      )
      .finally(() => {
        menuOpen = false;
      });
  }

  function onTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
    // While the voice menu overlay is focused, pass all keys through to it.
    if (menuOpen) return undefined;
    // Voice & speed menu.
    if (matchesKey(data, cfg.input.voiceShortcut)) {
      if (state.ctx) openVoiceMenu(state.ctx);
      return { consume: true };
    }
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
    const isEsc = matchesKey(data, "escape");
    if (!state.enabled) {
      // /say runs with talk mode off: Esc interrupts it too (cut speech + abort).
      if (isEsc && (state.busy || state.speaking)) {
        speaker.stop();
        if (state.busy) state.ctx?.abort();
        return { consume: true };
      }
      return undefined;
    }
    // Talk mode is on. The talk key is polled natively for recording, but the
    // terminal still DELIVERS it (F-keys are real keys), so consume it here so it
    // never reaches the editor/pi-vim. Space and everything else stays editable.
    if (matchesKey(data, cfg.input.key)) return { consume: true };
    if (!isEsc) return undefined;

    if (state.recording && recorder) {
      recorder.cancel();
      recorder = null;
      return { consume: true };
    }
    if (state.transcribing) {
      // Brief submit window — don't steal pi-vim's Esc.
      return undefined;
    }
    if (state.busy || state.speaking) {
      // Cut the AI short / interrupt speech (works even while the queued TTS is still reading).
      speaker.stop();
      if (state.busy) state.ctx?.abort();
      return { consume: true };
    }
    // Idle: let Esc reach pi-vim/editor. Esc still never exits talk mode.
    return undefined;
  }

  function attach(ctx: ExtensionContext) {
    state.ctx = ctx;
  }

  async function offerSaveTranscript(
    ctx: ExtensionContext,
  ): Promise<{ file: string; summary: string | null } | null> {
    const transcript = listener.transcriptText.trim();
    if (!transcript) return null;
    const want = await ctx.ui.confirm(
      "Save meeting transcript?",
      `${listener.chunkCount} segments recorded. Save as Markdown with a summary at the top?`,
    );
    const rawPath = listener.filePath;
    if (!want) {
      ctx.ui.notify(`Raw transcript kept at ${rawPath}`, "info");
      return rawPath ? { file: rawPath, summary: null } : null;
    }
    ctx.ui.notify("Summarizing meeting…", "info");
    try {
      const { slug, summary } = await summarizeMeeting(cfg, transcript);
      const dir = cfg.listen.outputDir.startsWith("~")
        ? join(homedir(), cfg.listen.outputDir.slice(1))
        : cfg.listen.outputDir;
      const date = new Date(listener.startTime || Date.now()).toISOString().slice(0, 10);
      let file = join(dir, `${date}_${slug}.md`);
      let i = 1;
      while (existsSync(file)) file = join(dir, `${date}_${slug}-${i++}.md`);
      writeFileSync(file, `# Meeting — ${slug}\n\n## Summary\n${summary}\n\n## Transcript\n${transcript}\n`);
      if (rawPath && rawPath !== file) {
        try {
          rmSync(rawPath, { force: true });
        } catch {
          // keep the raw copy if it cannot be removed
        }
      }
      ctx.ui.notify(`Transcript saved to ${file}`, "info");
      return { file, summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Could not summarize (${msg}); raw transcript kept at ${rawPath}`, "warning");
      return rawPath ? { file: rawPath, summary: null } : null;
    }
  }

  /**
   * Keep the discussion usable after /listen stops by leaving a durable note in the
   * conversation. A summary costs a couple hundred tokens on every later turn; the
   * whole transcript can cost thousands, so the default is the summary and the file
   * stays searchable through the `listen_transcript` tool.
   */
  async function handTranscriptToContext(
    ctx: ExtensionContext,
    saved: { file: string; summary: string | null } | null,
    transcript: string,
  ) {
    const mode = cfg.listen.contextMode;
    if (mode === "none" || !transcript) return;

    const where = saved?.file ? `\n\nFull transcript: ${saved.file}` : "";
    const lines = transcript.split("\n").length;
    let body: string;
    if (mode === "full") {
      // generous but bounded: a very long meeting should not blow up every request
      const cap = 20_000;
      const clipped = transcript.length > cap ? `…\n${transcript.slice(-cap)}` : transcript;
      body =
        `Meeting transcript (${lines} lines, oldest first, HH:MM:SS):\n\n${clipped}${where}\n\n` +
        "The recording has stopped; this transcript is the record of what was said.";
    } else {
      const recap = saved?.summary?.trim() || firstLines(transcript, 12);
      body =
        `A /listen session just ended (${lines} lines transcribed). Summary:\n\n${recap}${where}\n\n` +
        "Use the listen_transcript tool to search the full transcript for details.";
    }

    try {
      await pi.sendMessage(
        { customType: "listen-transcript", content: body, display: false },
        { triggerTurn: false },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Could not keep the transcript in context: ${msg}`, "warning");
    }
  }

  /** Compact fallback when no summary could be generated. */
  function firstLines(transcript: string, max: number): string {
    return transcript.split("\n").slice(0, max).join("\n");
  }

  // ── Incremental meeting context ─────────────────────────────────────────────
  // Instead of rewriting a system-prompt section every turn (which destroyed prompt
  // caching), append only what was said since the last turn as a tail message. Once
  // the accumulated verbatim transcript exceeds `listen.contextWindowChars`, collapse
  // it into a recap so the context stays bounded.

  let injectingMeeting = false;

  async function injectMeetingDelta() {
    if (injectingMeeting || !state.listenRecording) return;
    const delta = listener.pendingDeltaText();
    if (!delta.trim()) return;
    injectingMeeting = true;
    try {
      const cap = cfg.listen.contextWindowChars;
      if (listener.injectedChars + delta.length > cap) {
        const recap = await summarizeMeeting(cfg, listener.transcriptText);
        listener.injectedChars = 0;
        await pi.sendMessage(
          { customType: "meeting-recap", content: `Meeting recap so far:\n${recap.summary}`, display: false },
          { triggerTurn: false },
        );
      } else {
        listener.injectedChars += delta.length;
        await pi.sendMessage(
          { customType: "meeting-transcript", content: delta, display: false },
          { triggerTurn: false },
        );
      }
      listener.markInjected();
    } catch (err) {
      // Best-effort: never break a turn over context injection.
      const msg = err instanceof Error ? err.message : String(err);
      state.ctx?.ui.notify(`Could not add meeting transcript to context: ${msg}`, "warning");
    } finally {
      injectingMeeting = false;
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
      const transcript = listener.transcriptText.trim();
      const saved = await offerSaveTranscript(ctx);
      listener.forget(); // moves the raw path into savedPath
      if (saved?.file) listener.remember(saved.file);
      await handTranscriptToContext(ctx, saved, transcript);
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

  function headsetOn(): boolean {
    return state.headsetConnected === true;
  }

  /** Probe the headset once at conference start so the right column is chosen. */
  async function ensureHeadsetKnown() {
    if (state.headsetConnected !== null) return;
    if (!cfg.audio.headsetDevice) {
      state.headsetConnected = false;
      return;
    }
    try {
      const probe = await probeDevice(pi, cfg.audio.headsetDevice);
      state.headsetConnected = probe ? probe.present && probe.alive && probe.outStreams > 0 : false;
      refreshStatus();
    } catch {
      state.headsetConnected = false;
    }
  }

  /** Point the system defaults at the conference devices for the current column. */
  async function applyConferenceDevices() {
    const col = conferenceColumn(cfg, headsetOn());
    await setDefaultDevice(pi, "input", cfg.conference.systemInputDevice);
    await setDefaultDevice(pi, "output", col.systemOutputDevice);
  }

  /** Re-route when the headset connects/disconnects mid-call. */
  function onHeadsetChanged(connected: boolean) {
    if (!state.conference) return;
    void (async () => {
      try {
        await applyConferenceDevices();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state.ctx?.ui.notify(`Audio re-route failed: ${msg}`, "warning");
        return;
      }
      const col = conferenceColumn(cfg, connected);
      state.ctx?.ui.notify(
        connected
          ? `Headset connected — audio routed to ${col.voiceDevice}`
          : `Headset disconnected — audio routed to ${col.voiceDevice}`,
        connected ? "info" : "warning",
      );
    })();
  }

  async function restoreSystemDevices(ctx?: ExtensionContext) {
    try {
      // Leave the Multi-Output world: land on a direct device (headset if connected,
      // built-in speakers otherwise) rather than the pre-conference default, which
      // can itself be a leftover Multi-Output.
      const output = localPlaybackDevice(cfg, state.headsetConnected) || prevOutputDevice;
      if (output) await setDefaultDevice(pi, "output", output);
      // Input always goes back to the built-in mic — never the headset mic.
      if (cfg.input.micDevice) await setDefaultDevice(pi, "input", cfg.input.micDevice);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx?.ui.notify(`Failed to restore system audio: ${msg}`, "warning");
    } finally {
      prevOutputDevice = null;
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
      await ensureHeadsetKnown();
      if (cfg.conference.relayMic) relay.start();
      listener.setRemoteTap(cfg.conference.remoteTap);
      refreshStatus();
      ctx.ui.notify(`Conference mode on — pi's voice to ${conferenceColumn(cfg, headsetOn()).voiceDevice}`, "info");
      if (cfg.conference.switchSystemDevices) {
        try {
          prevOutputDevice = await getDefaultDevice(pi, "output");
          await applyConferenceDevices();
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
      const out = localPlaybackDevice(cfg, state.headsetConnected);
      ctx.ui.notify(out ? `Conference mode off — audio back to ${out}` : "Conference mode off", "info");
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  pi.registerCommand("talk", {
    description: `Toggle voice mode: hold ${displayKey(cfg.input.key)} to talk, pi answers out loud`,
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

  pi.registerCommand("voice", {
    description: "Open the voice & speed menu for pi's speech",
    handler: async (_args, ctx) => openVoiceMenu(ctx),
  });

  pi.registerCommand("say", {
    description: "Type to pi and have the reply read out loud",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Say mode requires the interactive terminal", "error");
        return;
      }
      const text = (args ?? "").trim();
      if (!text) {
        ctx.ui.notify("Usage: /say <message> — pi answers out loud", "info");
        return;
      }
      pendingSay = cfg.say.mode;
      attach(ctx);
      pi.sendUserMessage(text);
    },
  });

  // ── Listen transcript tool ─────────────────────────────────────────────────
  pi.registerTool(
    defineTool({
      name: "listen_transcript",
      description:
        "Search the transcript recorded by /listen. Pass a word or phrase to find matching lines with timestamps, " +
        "or an empty string to see the most recent transcript. Works during a session and after it stops, when it " +
        "reads the saved Markdown file. Use it whenever the user asks what was said.",
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
    stopTalkKeyWatcher();
    lastReleaseAt = 0;
    sayMode = false;
    pendingSay = false;
    sayQueue = [];
    sayStream.reset();
    recorder?.cancel();
    recorder = null;
    speaker.stop();
    speech.reset();
    if (ctx.mode === "tui") {
      terminalUnsub?.();
      terminalUnsub = ctx.ui.onTerminalInput((data) => onTerminalInput(data));
    }
    headset.start();
    refreshStatus();
  });

  pi.on("session_shutdown", async () => {
    stopTalkKeyWatcher();
    recorder?.cancel();
    recorder = null;
    speaker.stop();
    listener.reset();
    relay.stop();
    await restoreSystemDevices();
    terminalUnsub?.();
    terminalUnsub = null;
    headset.stop();
    clearStatus();
    resetState();
  });

  pi.on("agent_start", (_ev, ctx) => {
    attach(ctx);
    state.busy = true;
    state.speaking = false;
    speaker.stop(); // drop any stale speech from a previous run
    speech.reset();
    sayMode = pendingSay; // a queued /say now owns this turn's spoken replies
    pendingSay = false;
    sayStream.reset();
    sayQueue = [];
    refreshStatus();
  });

  pi.on("agent_end", (_ev, ctx) => {
    attach(ctx);
    state.busy = false;
    if (sayMode !== "approval") sayMode = false; // approval is cleared in agent_settled
    refreshStatus();
  });

  pi.on("agent_settled", (ev, ctx) => {
    attach(ctx);
    state.busy = false;
    // Leave state.speaking alone: the Speaker owns it while the remaining queue plays.
    if (sayMode === "approval") {
      const sentences = sayQueue.splice(0);
      sayMode = false;
      if (!state.enabled && !ev.aborted && sentences.length > 0) void approveSay(ctx, sentences);
    }
    // Fold what was heard since the last turn into context (append-only, tail).
    void injectMeetingDelta();
    refreshStatus();
  });

  // ── Streaming speech ────────────────────────────────────────────────────────
  pi.on("message_start", (ev, ctx) => {
    attach(ctx);
    if ((ev.message as any)?.role === "assistant") speech.reset();
  });

  pi.on("message_update", (ev, ctx) => {
    attach(ctx);
    if (state.recording || state.transcribing) return; // never speak over the user's recording
    if ((ev.message as any)?.role !== "assistant") return;
    if (state.enabled || sayMode === "auto") {
      for (const s of speech.feed(assistantText(ev.message))) speaker.enqueue(s);
    } else if (sayMode === "approval") {
      for (const s of sayStream.feed(assistantText(ev.message))) sayQueue.push(s);
    }
  });

  pi.on("message_end", (ev, ctx) => {
    attach(ctx);
    if (state.recording || state.transcribing) return; // never speak over the user's recording
    if ((ev.message as any)?.role !== "assistant") return;
    if (state.enabled || sayMode === "auto") {
      for (const s of speech.flush()) speaker.enqueue(s);
    } else if (sayMode === "approval") {
      for (const s of sayStream.flush()) sayQueue.push(s);
    }
  });

  // ── Context injection (voice nudge + listen transcript) ───────────────────
  pi.on("before_agent_start", (ev) => {
    if ((state.enabled || sayMode || pendingSay) && cfg.promptNudge) {
      const guidelines = ev.systemPromptOptions?.promptGuidelines;
      if (Array.isArray(guidelines)) guidelines.push(VOICE_NUDGE);
    }
    // Meeting transcript is no longer injected here (that rewrite every turn wrecked
    // prompt caching). It is appended incrementally as tail messages instead.
  });
}