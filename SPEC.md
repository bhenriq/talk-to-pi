# talk-to-pi — voice mode for pi

A pi extension that adds a `/talk` mode: **hold space to speak**, pi answers **out loud**.

Status: implemented. `/talk`, `/listen` (pi-labeled lines + summary save-on-stop), and `/conference`
(BlackHole routing + system-device switch) are wired and smoke-tested; push-to-talk, STT/TTS, the
transcript pipeline, and the save-with-summary flow verified live. Conference routing is verified
against the installed BlackHole devices but still warrants a real-call shakedown.

---

## 1. Activation

| | |
|---|---|
| Command | `/talk` — toggles voice mode on/off (or `ctrl+shift+t`) |
| Default on session start | **off** (mode is not persisted across sessions) |
| Off means | keys behave exactly like stock pi; no recording, no speech |
| Off-switch | `/talk` again or `ctrl+shift+t`. **Esc never exits a mode** — only the command/shortcut toggles on/off |

While the mode is on, a footer status shows the state:
`🎙 talk: idle` / `🎙 listening` / `🎙 transcribing …` / `🧠 thinking …` / `🔊 speaking`.
During the wait (transcribing or thinking — i.e. from releasing space until pi starts speaking),
the trailing waveform animates every ~120 ms and stops as soon as speech starts or the mode turns off.

An **audible** cue plays over the same window: two very soft alternating notes (`sox synth` →
`afplay`, ~0.6 s apart), so work is hearable from release until pi begins answering. It is
generated once, cached in the temp dir, and killed on speech/Esc/mode-off. See `audio.*` config.

While talk mode is on, **space is reserved for recording** and never inserted into the editor; all
other keys behave normally (including typing, except space).

## 2. Speaking to pi (STT)

**Hold space** → recording starts. **Release space** → recording stops, audio is transcribed,
transcript is **auto-submitted** as a normal user message.

- Release detection, in order of preference:
  1. **Native key-state poll** — `CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, 49)`
     sampled every ~25 ms via a tiny compiled helper (`clang`, cached binary). The keypress itself
     still arrives through the terminal, so focus and key identity come from pi, not the poll.
  2. **Autorepeat fallback** — if the poll reports space as always up (no AX trust), infer release
     from autorepeats ceasing for ~150 ms; recordings shorter than 400 ms are discarded.
- Reason: iTerm2 + tmux do not deliver Kitty key-release events, so the terminal cannot report release.
  The OS keyboard state bypasses tmux entirely.
- A space press within 250 ms of a release is ignored (debounce), so the tail of a hold never restarts recording.
- **Space while pi is speaking** barge-ins: it interrupts (stops speech + aborts the run) **and** starts
  a new recording immediately, so you can retake the turn.
- **Esc while recording** cancels: recording discarded, nothing submitted.
- **While pi is busy** (run in progress), holding space does nothing at all. Interrupting work is done
  with Esc (see §4).
- Recordings shorter than ~0.4 s, or that transcribe to empty, are discarded with a status flash.

### Transcription

```
sox -q -t coreaudio <input.micDevice> -r 16000 -c 1 -b 16 <tmp>.wav   # record (named mic, never the headset mic)
base64 <tmp>.wav                                 # -> input_audio
POST https://openrouter.ai/api/v1/chat/completions
  model: mistralai/voxtral-small-24b-2507
  content: [ {type:"text", prompt}, {type:"input_audio", input_audio:{data, format:"wav"}} ]
```

- Auth: `~/.pi/agent/auth.json` → `openrouter.access` (OAuth token, usable as an API key, no expiry).
- Measured: 1.6 s for a 6 s utterance; accurate on technical terms (`src/auth.ts`).
- Model id is configurable (e.g. a `gemini-*-flash` model for cheaper turns).

## 3. Hearing pi (TTS)

- Assistant output is voiced **sentence by sentence as it streams**, so the first words are heard
  while the answer is still being generated.
- **All** assistant prose in the run is spoken (each assistant message as it streams), not only the
  final reply — short lead-ins like "I'll run the tests" are spoken.
- Only assistant **prose** is spoken:
  - Markdown decoration stripped (`**`, backticks, `#`, bullets, links → text).
  - Fenced code blocks are skipped **silently**.
  - Tool calls, tool results, thinking, and confirm dialogs are never spoken.
- `tts.provider: "openrouter"` (default) sends text to OpenRouter `/api/v1/audio/speech` with model
  `elevenlabs/eleven-flash-v2.5` and voice `aria` (voice id `9BWtsMINqrJLrRacOk9x`); the MP3 reply is
  written to a temp file and played with `afplay`, then deleted. On any network/API error it falls
  back to `say`.
- `tts.provider: "say"` uses macOS `say`; `tts.sayVoice: "auto"` picks the best installed English
  voice at runtime (Samantha / Flo / Reed / …), override via config.
- Talk mode injects a **voice-style nudge** into the system prompt: answers are heard, not read —
  lead with the answer, 1–3 short sentences, no headers/tables/bullets.
- **Runtime voice/speed menu** (`ctrl+shift+o` or `/voice`): an overlay lets you pick the voice
  and speed (0.8×–1.2×) between utterances; applied to the next sentence. Cloud TTS passes a
  `speed` param (clamped to the ElevenLabs 0.7–1.2 range); the `say` provider uses `say -r`.

## 4. Interrupting pi

**Esc while pi is speaking or working → audio stops immediately and the run is aborted.** Back to idle; hold
space again to talk.

- **Esc while idle** does nothing — Esc never exits a mode; only `/talk`, `/listen`, or the
  `ctrl+shift+t` / `ctrl+shift+l` shortcuts toggle modes.
- **Esc while transcribing** is ignored (the transcript still auto-submits).
- **Space while pi is speaking** barge-ins: same interrupt as Esc, plus a new recording starts immediately.
- Killing the audio means killing the active playback process (`afplay` for cloud TTS, `say` for the
  offline provider) and dropping the sentence queue; nothing already killed can leak through.

## 5. Configuration (`config.json` next to the extension)

| key | default |
|---|---|
| `stt.model` | `mistralai/voxtral-small-24b-2507` |
| `stt.sampleRate` | `16000` |
| `tts.provider` | `openrouter` (`say` = offline) |
| `tts.command` | `say` (only used by the `say` provider) |
| `tts.sayVoice` | `auto` (best installed English voice at runtime) |
| `tts.voice` | `aria` (friendly name or ElevenLabs voice id) |
| `tts.model` | `elevenlabs/eleven-flash-v2.5` |
| `tts.format` | `mp3` |
| `stt.channels` / `stt.bits` | `1` / `16` |
| `input.key` | `space` |
| `input.keyCode` | `49` (macOS virtual keycode for space) |
| `input.pollMs` | `25` |
| `input.repeatSilenceMs` | `150` |
| `input.debounceMs` | `250` |
| `input.minRecordingMs` | `400` |
| `input.listenShortcut` | `ctrl+shift+l` |
| `input.talkShortcut` | `ctrl+shift+t` |
| `input.conferenceShortcut` | `ctrl+shift+c` |
| `input.voiceShortcut` | `ctrl+shift+o` |
| `input.micDevice` | `MacBook Pro Microphone` |
| `conference.outputDevice` | `Pi Talks (Zoom mic)` |
| `conference.roomDevice` | `BlackHole 2ch` |
| `conference.remoteTapDevice` | `BlackHole 16ch` |
| `conference.relayMic` / `remoteTap` / `muteBusyCue` | `true` |
| `conference.systemInputDevice` | `BlackHole 2ch` |
| `conference.systemOutputDevice` | `Pi Listens (Zoom speaker)` |
| `conference.switchSystemDevices` | `true` |
| `promptNudge` | `true` |
| `audio.processingCue` | `true` |
| `audio.volume` | `0.4` |
| `audio.intervalMs` | `650` |
| `listen.model` | `deepgram/nova-3` |
| `listen.chunkSeconds` | `5` |
| `listen.skipSilence` / `silenceThreshold` | `true` / `0.005` |
| `listen.outputDir` | `~/.pi/listen` |
| `listen.contextWindowChars` | `6000` |
| `listen.widgetLines` | `8` |
| `listen.summaryModel` | `deepseek/deepseek-chat` |

## 6. Packaging

- Lives in this repo (`~/Documents/Dev/talk-to-pi`), installed as
  `~/.pi/agent/extensions/talk` → symlink to the repo, so it loads in every pi session.
- Dev loop: `pi --extension ./talk-to-pi` or `/reload` in an existing session.

## 7. Engineering constraints

- Never start timers/processes in the extension factory: start on `session_start`, clean up in
  `session_shutdown` (idempotently). Kill `sox`, `say`/`afplay`, the key-watcher/audio-default helpers,
  the relay, and all timers on shutdown and on `/talk` off; restore the previous system default audio devices.
- Keyboard capture via `ctx.ui.onTerminalInput()`, which intercepts raw keys **before** the editor.
  Consume space/Esc while talk mode is on; return `undefined` for everything else so normal editing —
  including pi-vim — is untouched. **No editor replacement, so pi-vim coexists without loss.**
- **Unsent editor text** is left untouched: a voiced transcript always auto-submits as its own message.
- Track busy state from `agent_start` / `agent_end` / `agent_settled`.
- Terminal-only behavior guarded by `ctx.mode === "tui"`; the extension must not break non-interactive modes.
- Errors (mic missing, network, API failure) surface as a short status/notify and never crash the session.
- Temp WAV files are removed after transcription; TTS MP3 temp files are removed after playback.

## 8. Listen mode (`/listen`)

A separate, listen-only mode. `/listen` or the `ctrl+shift+l` shortcut toggles it.

- Repeatedly records the **microphone** into raw PCM with `sox` and slices it into
  `listen.chunkSeconds` chunks; silent chunks (RMS < `silenceThreshold`) are skipped.
- Each speaking chunk is transcribed via OpenRouter `/api/v1/audio/transcriptions`
  (`listen.model`, default `deepgram/nova-3`), ~5 s behind real time. No diarization.
- Transcript accumulates in memory and is appended to a Markdown file in `listen.outputDir`.
- **Context**: the last `contextWindowChars` of the transcript is injected into the system
  prompt on every turn (a `listen_transcript` prompt section); a model-callable
  `listen_transcript` tool searches the full transcript for older content.
- Listen mode is independent of talk mode and does not trigger TTS or the busy cue.
- Footer shows `📝 listen: recording · N segments`; a widget above the editor shows only the last
  `listen.widgetLines` transcript lines (status bar is the sole listening indicator).
- pi's own spoken answers are appended as `pi: …` lines (exact text, no STT) while listening;
  pi is the only identified speaker, other lines are unlabeled.
- **On stop**, pi offers to save a finalized Markdown file: an LLM summary at the top and filename
  `YYYY-MM-DD-<slug>.md` (date + a slug summarizing the meeting); declining keeps the raw file.

## 9. Conference mode (`/conference`)

Routes pi into a call app, using `sox -t coreaudio` device targeting (no native code).

- **TTS destination**: while on, pi's spoken replies are played into `conference.outputDevice`
  (a Multi-Output of your headphones + `roomDevice`) so both you and the room hear them.
- **Mic relay**: `sox micDevice → roomDevice` continuously, so the room hears you too. Relies on
  the assumption that you do not speak at the same time as pi (no mixer required).
- **Remote tap**: `/listen` adds a second capture source (`remoteTapDevice`) while conference mode
  is on, so the transcript includes remote participants as well as your mic. Timestamps are wall-clock,
  interleaving both sources.
- Mutes the busy cue (`muteBusyCue`) so the room never hears it.
- Status bar shows `🔊 conf: on`. Toggled by `/conference` or `ctrl+shift+c`.
- **System device switch**: on enter, the system default input/output are captured and set to
  `systemInputDevice` / `systemOutputDevice` (so a call app aligned on "same as system" follows);
  on exit, reload, or shutdown the previous devices are restored (native `audio-default` helper).

Requires BlackHole 2ch + 16ch and an Audio MIDI Setup of two Multi-Output devices (documented in README).

## 10. Out of scope (for now)

- VAD / silence-based auto-stop, continuous listening.

- Speaking tool activity or a summary-only mode.
- Local STT (`whisper.cpp`), macOS Speech framework.
- Streaming (byte-level) TTS playback — we synthesize per sentence and buffer.
- Voice cloning / custom ElevenLabs voices.
- Languages other than English.
