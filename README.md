# talk-to-pi

A pi extension that adds a **`/talk`** voice mode: hold space to talk, pi answers out loud.

- **Hold `space`** → pi records your voice (`sox` → OpenRouter `input_audio` STT).
- **Release** → pi transcribes and auto-submits it as your message.
- **Esc** → stop pi talking and abort the run (or cancel an in-progress recording). Esc never exits a mode.
- pi's answers are **spoken aloud** (OpenRouter → ElevenLabs TTS by default, `say` offline fallback), streamed sentence by sentence.

See [`SPEC.md`](SPEC.md) for the full behaviour contract and [`config.json`](config.json) for tunables.

## Install

```sh
# global (available in every pi session)
ln -sfn "$PWD" ~/.pi/agent/extensions/talk

# or project-only during development
pi --extension ./talk-to-pi
```

Restart pi (or run `/reload`), then type `/talk`.

## Usage

| key | when | action |
|---|---|---|
| **hold `space`** | idle, talk mode on | start recording |
| **space** | while pi is speaking | interrupt + start recording (barge-in) |
| `ctrl+shift+t` | any time | toggle `/talk` |
| `ctrl+shift+l` | any time | toggle `/listen` |
| `ctrl+shift+c` | any time | toggle `/conference` |
| **release** | recording | stop, transcribe, submit |
| **Esc** | recording | cancel recording |
| **Esc** | while pi is working/speaking | stop audio + abort the run |
| **Esc** | idle | does nothing (never exits a mode) |
| `/talk` | any time | toggle talk mode |

While talk mode is on, `space` is reserved for recording (it is never inserted into the
editor); all other keys behave normally.

The footer shows the current state: `🎙 talk: idle` · `🎙 listening` · `🎙 transcribing…` ·
`🧠 thinking` · `🔊 speaking`. While waiting (transcribing or thinking), the wave animates so
you can see pi is working from the moment you release space until it starts speaking back.

A soft two-note audio cue (a gentle low→high blip every ~0.6 s) plays during the same wait
window, so you can also **hear** that pi is processing. It stops the instant speech starts or
the mode turns off. Disable it with `audio.processingCue: false`.

## Listen mode

`/listen` records the **microphone** continuously and transcribes it in ~5 s chunks via
OpenRouter's `/audio/transcriptions` endpoint (default `deepgram/nova-3`), skipping silence.
The running transcript is appended to a Markdown file and made available to pi:

- the **most recent part** is injected into the system prompt on every turn, and
- the **`listen_transcript` tool** lets pi search the whole transcript for older content.

While listening, pi's own spoken answers are appended too, labeled `pi:` — pi is the only
identified speaker (everyone else is unlabeled).

`/listen` (or `ctrl+shift+l`) toggles recording; the footer shows `📝 listen: recording · N segments`.
The most recent transcript lines stream in a widget above the editor.

When you **stop** `/listen`, pi offers to save a finalized Markdown file: an LLM-written
summary at the top, and a filename like `2026-10-18-q3-launch-plan.md` (date + a slug
summarizing the meeting). Declining keeps the raw transcript file. Output dir: `~/.pi/listen/`.

## Conference mode

`/conference` (or `ctrl+shift+c`) lets pi join your Zoom/Meet call.

While it's on, the extension also flips the **system default input/output** to
`BlackHole 2ch` / `Pi Listens (Zoom speaker)` and restores your previous devices when you
toggle off — so a call app set to "same as system" follows automatically (no per-app settings).

- **pi speaks → you and the room.** pi's TTS is played into a Multi-Output device
  (your headphones + BlackHole 2ch), so you hear it and the room hears it through Zoom's
  microphone.
- **room hears you too.** your microphone is relayed into BlackHole (since you never talk at
  the same time as pi, no mixer is needed).
- **`/listen` hears everyone.** while conference mode is on, `/listen` also transcribes the
  remote meeting audio (tapped from BlackHole 16ch) alongside your mic.
- the busy blip is silenced while conference mode is on.

**One-time setup:**

```sh
brew install --cask blackhole-2ch blackhole-16ch   # audio driver → log out/in
```

Then in **Audio MIDI Setup**: create `Pi Talks (Zoom mic)` = [your headphones/output + BlackHole 2ch],
and `Pi Listens (Zoom speaker)` = [your headphones/output + BlackHole 16ch].
In the call app: **Microphone = BlackHole 2ch**, **Speaker = Pi Listens (Zoom speaker)** — or leave both
on "same as system" and let `/conference` switch the system defaults for you.

## Requirements

- macOS (uses `say`, `afplay`, `sox`, and small compiled CoreAudio helpers)
- `sox` (`brew install sox`) for mic recording and device routing
- Xcode command-line tools (`clang`) to compile `native/keywatcher.m` and `native/audio-default.m` on first use
- `BlackHole 2ch` + `BlackHole 16ch` for conference mode (`brew install --cask blackhole-2ch blackhole-16ch`)
- An OpenRouter OAuth login in `~/.pi/agent/auth.json` (STT, cloud TTS, transcript summaries)

## Voices

The default TTS voice is **aria** (ElevenLabs Flash v2.5, through OpenRouter — no extra key).
Available curated voices, set via `tts.voice` in `config.json`:

`aria` · `rachel` · `sarah` · `adam` · `antoni` · `george` — or any raw ElevenLabs voice id.

To audition a cloud voice, generate a clip and listen:

```sh
curl -s https://openrouter.ai/api/v1/audio/speech \
  -H "Authorization: Bearer $(jq -r .openrouter.access ~/.pi/agent/auth.json)" \
  -H "Content-Type: application/json" \
  -d '{"model":"elevenlabs/eleven-flash-v2.5","input":"Alright, I will refactor the login handler.","voice":"9BWtsMINqrJLrRacOk9x","response_format":"mp3"}' \
  -o /tmp/voice.mp3 && afplay /tmp/voice.mp3
```

(`9BWtsMINqrJLrRacOk9x` = aria; the other curated ids map is in `src/speaker.ts`.)

Swap `tts.provider` to `"say"` for a fully offline voice, with `tts.sayVoice: "auto"`
picking the best installed macOS English voice.

## Configuration

Edit `config.json`:

| key | default | meaning |
|---|---|---|
| `stt.model` | `mistralai/voxtral-small-24b-2507` | OpenRouter model with `input_audio` support |
| `stt.sampleRate` / `channels` / `bits` | `16000` / `1` / `16` | sox capture format |
| `tts.provider` | `openrouter` | `openrouter` (cloud) or `say` (offline) |
| `tts.model` | `elevenlabs/eleven-flash-v2.5` | OpenRouter TTS model |
| `tts.voice` | `aria` | voice name or ElevenLabs voice id (cloud) |
| `tts.format` | `mp3` | output format for cloud TTS |
| `tts.command` | `say` | TTS binary used by the `say` provider |
| `tts.sayVoice` | `auto` | voice name for the `say` provider |
| `input.key` / `keyCode` | `space` / `49` | talk key |
| `input.listenShortcut` | `ctrl+shift+l` | toggle `/listen` |
| `input.talkShortcut` | `ctrl+shift+t` | toggle `/talk` |
| `input.conferenceShortcut` | `ctrl+shift+c` | toggle `/conference` |
| `input.micDevice` | `MacBook Pro Microphone` | the mic always used for talk + `/listen` (never the headset mic) |
| `input.pollMs` | `25` | native release-poll interval |
| `input.repeatSilenceMs` | `150` | autorepeat-fallback release threshold |
| `input.debounceMs` | `250` | ignore a press this soon after release |
| `input.minRecordingMs` | `400` | recordings shorter than this are discarded |
| `promptNudge` | `true` | append a voice-style instruction to the system prompt |
| `audio.processingCue` | `true` | audible blip while waiting (transcribing/thinking) |
| `audio.volume` | `0.4` | cue volume (0–1) |
| `audio.intervalMs` | `650` | pause between cue notes |
| `listen.model` | `deepgram/nova-3` | OpenRouter STT model |
| `listen.chunkSeconds` | `5` | transcription chunk size |
| `listen.skipSilence` / `silenceThreshold` | `true` / `0.005` | skip silent chunks |
| `listen.outputDir` | `~/.pi/listen` | transcript storage directory |
| `conference.outputDevice` | `Pi Talks (Zoom mic)` | where pi's TTS plays (headphones + BlackHole 2ch) |
| `conference.roomDevice` | `BlackHole 2ch` | the virtual device Zoom uses as its microphone |
| `conference.remoteTapDevice` | `BlackHole 16ch` | remote meeting audio tapped into `/listen` |
| `conference.relayMic` / `remoteTap` / `muteBusyCue` | `true` | relay, remote tap, and blip mute toggles |
| `conference.systemInputDevice` | `BlackHole 2ch` | system default input while conference is on |
| `conference.systemOutputDevice` | `Pi Listens (Zoom speaker)` | system default output while conference is on |
| `conference.switchSystemDevices` | `true` | auto-switch these on enter, restore on exit |
| `listen.contextWindowChars` | `6000` | recent transcript injected into the prompt |
| `listen.widgetLines` | `8` | transcript lines shown above the editor |
| `listen.summaryModel` | `deepseek/deepseek-chat` | model that writes the save-time summary + slug |

## How release is detected

Terminals inside tmux (and Terminal.app) do not deliver key-**release** events, so the
terminal cannot tell when you let go of space. talk-to-pi instead polls the macOS keyboard
state (`CGEventSourceKeyState`) via `native/keywatcher.m`, compiled on first use by the
extension. If the native poll cannot see the key, it falls back to autorepeat cadence.

## Costs

- **STT** (`voxtral-small`): ~$0.0006 per ~6 s utterance.
- **TTS default** (`elevenlabs/eleven-flash-v2.5`): ~$0.02 per 1k characters — roughly a
  cent for a handful of spoken sentences. Set `tts.provider: "say"` for zero cost.