#!/usr/bin/env node
// Synthesize the video narration with the extension's own TTS settings,
// then measure each clip so the visual timeline can be derived from it.
//
//   node video/tts.mjs
//
// Writes video/build/audio/s<N>.mp3 and video/build/timeline.json.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "build");
const audioDir = join(out, "audio");
mkdirSync(audioDir, { recursive: true });

const config = JSON.parse(readFileSync(join(here, "..", "config.json"), "utf8"));
const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
const token = auth?.openrouter?.access;
if (typeof token !== "string" || !token) throw new Error("no OpenRouter token in ~/.pi/agent/auth.json");

const VOICES = { rachel: "21m00Tcm4TlvDq8ikWAM", aria: "9BWtsMINqrJLrRacOk9x" };

const scenes = [
  {
    id: "hook",
    narration:
      "You type at forty words a minute. You speak at a hundred and fifty. So why are you still typing at your AI?",
  },
  {
    id: "shift",
    narration:
      "Talk to pi turns your terminal agent into a conversation. Three modes, one keyboard shortcut each.",
  },
  {
    id: "talk",
    narration:
      "Hold space, and pi records. Let go, and your words become your message, transcribed, not typed. " +
      "Pi answers out loud, sentence by sentence, while the text scrolls past like always. " +
      "Need to cut it off? Hold space again. Pi stops mid sentence and starts listening. That's barge in. " +
      "Escape stops the audio, and escape never drops you out of the mode. It only interrupts.",
  },
  {
    id: "listen",
    narration:
      "Slash listen, and pi starts taking notes. Everything said around the table is transcribed live, " +
      "with silence skipped. Pi reads that transcript, so you can ask what was decided about pricing " +
      "without repeating yourself. And when you stop, pi writes a summary and saves it as a dated " +
      "markdown file. Meeting notes, done.",
  },
  {
    id: "conference",
    narration:
      "Slash conference puts pi in the call. It speaks into your Zoom or Meet microphone, so the room " +
      "hears it, and it listens to the room and to the remote side at the same time. " +
      "Your audio devices switch automatically on the way in, and switch back when you leave. " +
      "Pi isn't a side window anymore. It's a participant.",
  },
  {
    id: "voice",
    narration:
      "Don't like the voice? Control shift O. Pick a voice, pick a speed. It applies to the next sentence.",
  },
  {
    id: "close",
    narration: "All of it runs on the OpenRouter login you already have. Hold space. That's it.",
  },
];

async function synth(text) {
  const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.tts.model,
      input: text,
      voice: VOICES[config.tts.voice] ?? config.tts.voice,
      response_format: "mp3",
      speed: Math.round(Math.min(1.2, Math.max(0.7, config.tts.speed)) * 100) / 100,
    }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("empty TTS response");
  return buf;
}

function duration(file) {
  const info = execFileSync("afinfo", [file], { encoding: "utf8" });
  const m = info.match(/estimated duration:\s*([\d.]+)/i);
  if (!m) throw new Error(`could not read duration of ${file}`);
  return Number(m[1]);
}

// Per-scene padding (seconds of quiet) added after the clip before the next scene.
const PAD = { hook: 0.4, shift: 0.5, talk: 0.5, listen: 0.5, conference: 0.5, voice: 0.4, close: 0.9 };

let cursor = 0.8; // lead-in before the first word
const timeline = [];
for (const [i, scene] of scenes.entries()) {
  const file = join(audioDir, `s${i + 1}-${scene.id}.mp3`);
  const buf = await synth(scene.narration);
  writeFileSync(file, buf);
  const dur = duration(file);
  const start = cursor;
  const end = start + dur + (PAD[scene.id] ?? 0.5);
  timeline.push({ ...scene, index: i + 1, audio: file, duration: dur, start, audioEnd: start + dur, end });
  console.log(`${String(i + 1).padStart(2)} ${scene.id.padEnd(11)} ${dur.toFixed(2)}s @ ${start.toFixed(2)}s`);
  cursor = end;
}

const total = timeline[timeline.length - 1].end;
writeFileSync(join(out, "timeline.json"), JSON.stringify({ total, fps: 12, scenes: timeline }, null, 2));
console.log(`\ntotal ${total.toFixed(2)}s → ${join(out, "timeline.json")}`);
