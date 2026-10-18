# talk-to-pi — explainer video script

- **Runtime:** ~2:00
- **Narration:** ~300 words, `elevenlabs/eleven-flash-v2.5`, voice `rachel`, speed 1.2×
  (the extension's own default voice — the video sounds like the product)
- **Visuals:** animated terminal mockup rendered deterministically from `video/scene.html`
- **Audience:** developers seeing the repo for the first time

Scene times are computed at build time from the narration durations, so they are
not hardcoded here: `video/build/timeline.json` is the source of truth.

---

## 1 — Hook

> You type at forty words a minute. You speak at a hundred and fifty.
> So why are you still typing at your AI?

**Screen:** empty pi prompt, a single cursor. Words type in slowly. Stat overlay
`40 wpm` vs `150 wpm`.

## 2 — The shift

> Talk to pi turns your terminal agent into a conversation.
> Three modes, one keyboard shortcut each.

**Screen:** title card. Three chips slide in: `/talk`, `/listen`, `/conference`.

## 3 — Talk mode

> Hold space, and pi records. Let go, and your words become your message — transcribed, not typed.
> Pi answers out loud, sentence by sentence, while the text scrolls past like always.
> Need to cut it off? Hold space again. Pi stops mid-sentence and starts listening. That's barge-in.
> Escape stops the audio, and escape never drops you out of the mode. It only interrupts.

**Screen:** footer `🎙 talk: idle` → space held → live waveform + `🎙 listening` → release →
`🎙 transcribing…` → `🧠 thinking` → `🔊 speaking` with the spoken sentence highlighted.
A second space press mid-speech cuts the audio and recording restarts.

## 4 — Listen mode

> Slash listen, and pi starts taking notes. Everything said around the table is transcribed
> live, with silence skipped.
> Pi reads that transcript, so you can ask what was decided about pricing without repeating yourself.
> And when you stop, pi writes a summary and saves it as a dated markdown file. Meeting notes, done.

**Screen:** transcript lines stream into the widget above the editor. A question about
"pricing" gets a grounded answer. On stop, a `2026-10-18_q3-launch-plan.md` card appears
with the summary at the top.

## 5 — Conference mode

> Slash conference puts pi in the call. It speaks into your Zoom or Meet microphone, so the room
> hears it — and it listens to the room and to the remote side at the same time.
> Your audio devices switch automatically on the way in, and switch back when you leave.
> Pi isn't a side window anymore. It's a participant.

**Screen:** split view — a call window with three participants beside the terminal.
Arrows show `pi → call mic` and `remote audio → transcript`.

## 6 — Voice

> Don't like the voice? Control-shift-O. Pick a voice, pick a speed.
> It applies to the next sentence.

**Screen:** voice menu overlay, `rachel` selected, speed scale `0.8× → 1.2×` with `1.2×` active.

## 7 — Close

> All of it runs on the OpenRouter login you already have. Hold space. That's it.

**Screen:** logo, `hold space` keycap, repo URL.

---

## Production notes

- Frames are rendered by seeking the page clock (`window.seek(t)`), not by recording in real
  time, so narration and visuals always line up and no frames are dropped.
- Narration is synthesized per scene, measured with `afinfo`, then the scene start times are
  derived from those durations plus a small pad.
- Audio is assembled with ffmpeg `adelay`/`amix` at the exact same offsets used for rendering.
