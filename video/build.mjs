#!/usr/bin/env node
// Build the explainer video: timeline → deterministic frames → muxed MP4.
//
//   node video/build.mjs [--fps 12] [--keep]
//
// 1. writes video/build/timeline.js so scene.html can read the scene starts
// 2. captures every frame by seeking the page clock over CDP (no real-time
//    recording, so nothing drifts and no frames are dropped)
// 3. lays the narration on the same offsets and muxes with ffmpeg

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "build");
const framesDir = join(build, "frames");
const argv = process.argv.slice(2);
const FPS = Number(argv[argv.indexOf("--fps") + 1]) || 12;
const keep = argv.includes("--keep");

const timeline = JSON.parse(readFileSync(join(build, "timeline.json"), "utf8"));
const total = timeline.total;
writeFileSync(join(build, "timeline.js"), `window.TL = ${JSON.stringify(timeline)};\n`);

// ── audio bed on the exact same offsets ───────────────────────────────────
function buildAudio() {
  const out = join(build, "narration.wav");
  const inputs = timeline.scenes.flatMap((s) => ["-i", s.audio]);
  const filters = timeline.scenes
    .map((s, i) => `[${i}:a]aresample=44100,adelay=${Math.round(s.start * 1000)}:all=1[a${i}]`)
    .join(";");
  const mix = timeline.scenes.map((_, i) => `[a${i}]`).join("");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", ...inputs,
    "-filter_complex",
    `${filters};${mix}amix=inputs=${timeline.scenes.length}:normalize=0:dropout_transition=0,` +
      `apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[out]`,
    "-map", "[out]", "-ar", "44100", "-ac", "2", out,
  ]);
  console.log(`audio  ${out}`);
  return out;
}

// ── CDP plumbing ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error("chrome did not expose a page target");
}

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve) => (this.ws.onopen = resolve));
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function capture() {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const port = 9333;
  const proc = spawn(chrome, [
    "--headless=new", `--remote-debugging-port=${port}`, "--hide-scrollbars",
    "--force-device-scale-factor=1", "--window-size=1600,900",
    "--disable-extensions", "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + join(build, "chrome-profile"),
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const wsUrl = await cdp(port);
    const client = new Client(wsUrl);
    await client.ready;
    await client.send("Page.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await client.send("Page.navigate", { url: "file://" + join(here, "scene.html") });

    for (let i = 0; i < 200; i++) {
      const r = await client.send("Runtime.evaluate", { expression: "document.title" });
      if (r?.result?.value === "ready") break;
      await sleep(50);
    }

    const frames = Math.ceil(total * FPS);
    for (let f = 0; f < frames; f++) {
      const t = f / FPS;
      await client.send("Runtime.evaluate", { expression: `seek(${t.toFixed(4)})` });
      const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(framesDir, `f${String(f).padStart(5, "0")}.png`), Buffer.from(shot.data, "base64"));
      if (f % 100 === 0) process.stdout.write(`\rframes ${f}/${frames}  `);
    }
    process.stdout.write(`\rframes ${frames}/${frames}  \n`);
    client.ws.close();
  } finally {
    proc.kill("SIGKILL");
  }
}

async function mux(audio) {
  const out = join(here, "talk-to-pi.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(FPS), "-i", join(framesDir, "f%05d.png"),
    "-i", audio,
    "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-c:a", "aac", "-b:a", "160k",
    "-shortest", out,
  ]);
  console.log(`video  ${out}`);
  const { size } = execFileSync("ls", ["-lh", out], { encoding: "utf8" }) && { size: null };
  void size;
}

const audio = buildAudio();
await capture();
await mux(audio);
if (!keep) rmSync(join(build, "chrome-profile"), { recursive: true, force: true });
console.log("done");
