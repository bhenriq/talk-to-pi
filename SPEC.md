# talk-to-pi — voice mode for pi

A pi extension that adds a `/talk` mode: **hold space to speak** (or **type `/say`**), pi answers **out loud**.

Status: implemented. `/talk`, `/say`, `/listen` (pi-labeled lines + summary save-on-stop), and `/conference`
(BlackHole routing + system-device switch) are wired and smoke-tested; push-to-talk, STT/TTS, the
transcript pipeline, and the save-with-summary flow verified live. Conference routing is verified
against the installed BlackHole devices but still warrants a real-call shakedown.

---

## 1. Activation

| | |
|---|---|
| Command | `/talk` — toggles voice mode on/off (or `ctrl+shift+t`) |
| Typed command | `/say <message>` — send a typed message and have pi read the reply out loud (works with talk mode off; see `say.mode`) |
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

**`/say` is the typing path.** It never records the mic: it submits the typed text as a normal user
message and arms exactly one turn of spoken replies. It requires neither talk mode nor any key
handling, and clears automatically when the turn ends. `say.mode` picks the behavior:

- **`auto`** (default) — pi speaks the reply as it streams, with no interaction.
- **`approval`** — while the turn streams, the reply text is collected (not spoken); when the turn
  is ready (agent settles), pi shows the text in a dialog and waits. **Enter** speaks it,
  **Esc** skips it. Aborting the run suppresses the dialog.

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
  `elevenlabs/eleven-flash-v2.5` and voice `rachel` at 1× (voice id `21m00Tcm4TlvDq8ikWAM`); the MP3 reply is
  written to a temp file and played with `afplay`, then deleted. On any network/API error it falls
  back to `say`.
- `tts.provider: "say"` uses macOS `say`; `tts.sayVoice: "auto"` picks the best installed English
  voice at runtime (Samantha / Flo / Reed / …), override via config.
- Talk mode injects a **voice-style nudge** into the system prompt: answers are heard, not read —
  lead with the answer, 1–3 short sentences, no headers/tables/bullets.
- **Runtime voice/speed menu** (`ctrl+shift+o` or `/voice`): an overlay lets you pick the voice,
  speed (0.8×–1.2×), and `/say` reply mode (`auto` / `approval`). Voice and speed are applied to the
  next sentence; the `/say` mode is applied immediately and persisted to `config.json`. Cloud TTS
  passes a `speed` param (clamped to the ElevenLabs 0.7–1.2 range); the `say` provider uses `say -r`.

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
| `tts.voice` | `rachel` (friendly name or ElevenLabs voice id) |
| `tts.speed` | `1.0` |
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
| `conference.roomDevice` | `BlackHole 2ch` |
| `conference.remoteTapDevice` | `BlackHole 16ch` |
| `conference.relayMic` / `remoteTap` | `true` |
| `conference.muteBusyCue` | `false` |
| `conference.systemInputDevice` | `BlackHole 2ch` |
| `conference.switchSystemDevices` | `true` |
| `conference.headset.voiceDevice` | `Pi Talks (headset)` — pi → you(headset) + room |
| `conference.headset.systemOutputDevice` | `Pi Listens (headset)` — call → you(headset) + tap |
| `conference.builtin.voiceDevice` | `Pi Talks (speaker)` — pi → you(built-in) + room |
| `conference.builtin.systemOutputDevice` | `Pi Listens (speaker)` — call → you(built-in) + tap |
| `promptNudge` | `true` |
| `audio.processingCue` | `true` |
| `audio.volume` | `0.4` |
| `audio.headsetDevice` | `` (this repo: `OpenSwim Pro by Shokz`) |
| `audio.localSpeaker` | `` (this repo: `MacBook Pro Speakers`) — local playback when the headset is off |

| `audio.intervalMs` | `650` |
| `listen.model` | `deepgram/nova-3` |
| `listen.chunkSeconds` | `5` |
| `listen.skipSilence` / `silenceThreshold` | `true` / `0.005` |
| `listen.outputDir` | `~/.pi/listen` |
| `listen.contextWindowChars` | `6000` |
| `listen.widgetLines` | `8` |
| `listen.summaryModel` | `deepseek/deepseek-chat` |
| `listen.contextMode` | `summary` (or `full` / `none`) |
| `say.mode` | `auto` (or `approval`) — `/say` speaks as it streams, or shows and waits for Enter (also switchable in `ctrl+shift+o`) |

## 6. Packaging

- Lives in this repo (`~/Documents/Dev/talk-to-pi`), installed as
  `~/.pi/agent/extensions/talk` → symlink to the repo, so it loads in every pi session.
- Dev loop: `pi --extension ./talk-to-pi` or `/reload` in an existing session.

## 7. Engineering constraints

- Never start timers/processes in the extension factory: start on `session_start`, clean up in
  `session_shutdown` (idempotently). Kill `sox`, `say`/`afplay`, the key-watcher/audio-default helpers,
  the relay, and all timers on shutdown and on `/talk` off; on shutdown put the system input back to the
  built-in mic and the system output on a direct device (headset or built-in speakers), never a Multi-Output.
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
  `YYYY-MM-DD_<title>.md` — a `date_title` filename where the title is a short summary of the
  conversation; declining keeps the raw file.
- The live widget is hidden the moment capture stops (no repaint from a late chunk or a spoken
  reply); in-memory lines are dropped after the save prompt.
- **Context handoff**: stopping appends one durable custom message (`listen-transcript`) to the
  session so the discussion stays usable — `listen.contextMode: summary` (recap + file path),
  `full` (whole transcript, 20k-char cap) or `none`. It never triggers a turn.
- `listen_transcript` searches live lines first, then falls back to the saved Markdown file, so it
  keeps working after the session ends and the in-memory lines are gone.

## 9. Conference mode (`/conference`)

Routes pi into a call app, using `sox -t coreaudio` device targeting (no native code).

### Audio routing model (two dimensions)

Audio control is a 2×2: **local / remote** (row) × **headset on / off** (column). The row is the
`/conference` toggle; the column is detected automatically from `audio.headsetDevice`
(`state.headsetConnected`), re-routed live if the headset connects/disconnects mid-call.

| | headset on | headset off |
|---|---|---|
| **local** | mic `input.micDevice`, speaker `audio.headsetDevice` | mic `input.micDevice`, speaker `audio.localSpeaker` |
| **remote** | system in `BlackHole 2ch`, out `conference.headset.*` | system in `BlackHole 2ch`, out `conference.builtin.*` |

Decisions locked in:
- **Physical mic is always `input.micDevice`** (MacBook Pro mic). The Shokz's 16 kHz input is never
  used. `BlackHole 2ch` is only the *system input* (what the call app hears), fed by the mic relay.
- **"Headset" is baked into Multi-Output devices**, so on/off selects between two pre-built pairs:
  `conference.headset.*` vs `conference.builtin.*` (both pairs configured once in Audio MIDI Setup).
- **Local TTS plays to the macOS system default output** (`afplay`). Never `sox` to the headset by
  name: macOS exposes the Shokz as one input and one output device with the same name, and sox's
  CoreAudio driver cannot disambiguate. The system default already follows the headset
  (headset when connected, built-in speakers when it is not), and exit-time switching sets it via
  the direction-aware native helper rather than sox.
- **Echo risk accepted** for the built-in column: call audio out of the MacBook speakers next to an
  open mic. Headset is preferred; rely on the call app's echo cancellation otherwise.

- **TTS destination**: while on, pi's spoken replies are played into the active column's
  `voiceDevice` (a Multi-Output of your playback device + `roomDevice`) so both you and the room
  hear them.
- **Mic relay**: `sox micDevice → roomDevice` continuously, so the room hears you too. Relies on
  the assumption that you do not speak at the same time as pi (no mixer required).
- **Remote tap**: `/listen` adds a second capture source (`remoteTapDevice`) while conference mode
  is on, so the transcript includes remote participants as well as your mic. Timestamps are wall-clock,
  interleaving both sources.
- During conference the busy cue plays as a continuous loop through the active column's
  `voiceDevice` (sox, the voice path) so participants hear it; a single long-lived sox stream means
  the short notes are not swallowed by the Multi-Output's startup latency, and the `/listen` remote
  tap is not on that path. `muteBusyCue` (default false) silences it entirely in calls.
- Status bar shows `🔊 conf: on`. Toggled by `/conference` or `ctrl+shift+c`.
- **Headset watch**: while talk or conference is on, `audio.headsetDevice` is probed every 3 s via
  `audio-default probe` (present + alive + output streams). The footer shows `🎧 headset: on|off`
  and a transition notifies the user. A switched-off Bluetooth headset is absent from CoreAudio's
  device list, which is what makes this reliable; no probing happens while both modes are off.
- **System device switch**: on enter, the system default input/output are captured and set to
  `systemInputDevice` / the active column's `systemOutputDevice` (so a call app aligned on "same as
  system" follows); a headset connect/disconnect mid-call re-routes the output live. On exit,
  reload, or shutdown the **output goes to a direct device** (`audio.headsetDevice` if connected,
  else `audio.localSpeaker`) — never a leftover Multi-Output; the input goes back to the built-in
  mic `input.micDevice`, never the headset mic (native `audio-default` helper).

Requires BlackHole 2ch + 16ch and an Audio MIDI Setup of **four** Multi-Output devices (documented in README).

## 10. Out of scope (for now)

- VAD / silence-based auto-stop, continuous listening.

- Speaking tool activity or a summary-only mode.
- Local STT (`whisper.cpp`), macOS Speech framework.
- Streaming (byte-level) TTS playback — we synthesize per sentence and buffer.
- Voice cloning / custom ElevenLabs voices.
- Languages other than English.
