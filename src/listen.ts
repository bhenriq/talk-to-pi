import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TalkConfig } from "./config.ts";
import { readOpenRouterToken } from "./openrouter.ts";
import { refreshStatus, state } from "./state.ts";

const TRANSCRIBE_TIMEOUT_MS = 30_000;

/** Build a 44-byte RIFF/WAV header for 16-bit PCM. */
export function wavHeader(dataLen: number, sampleRate: number, channels = 1, bits = 16): Buffer {
  const b = Buffer.alloc(44);
  const blockAlign = channels * (bits / 8);
  const byteRate = sampleRate * blockAlign;
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bits, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

/** RMS of 16-bit little-endian PCM, normalised to 0..1. */
export function pcmRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  const n = pcm.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/**
 * Peak RMS over sliding windows, so a short sentence inside an otherwise quiet
 * chunk still counts as speech (whole-chunk RMS would dilute it below threshold).
 */
export function pcmWindowRms(pcm: Buffer, sampleRate: number, windowSeconds = 0.1): number {
  const windowBytes = Math.floor(sampleRate * 2 * windowSeconds);
  if (windowBytes < 2 || pcm.length < windowBytes) return pcmRms(pcm);
  let max = 0;
  for (let off = 0; off + windowBytes <= pcm.length; off += windowBytes) {
    const r = pcmRms(pcm.subarray(off, off + windowBytes));
    if (r > max) max = r;
  }
  return max;
}

/**
 * Continuous listen recorder: captures the mic with sox (raw PCM on stdout),
 * slices it into fixed-length chunks, transcribes each via OpenRouter
 * `/api/v1/audio/transcriptions`, and appends the result to a Markdown file.
 */
export class Listener {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pcm = Buffer.alloc(0);
  private bytesPerChunk: number;
  private queue: Promise<void> = Promise.resolve();
  private lines: Array<{ t: string; text: string }> = [];
  private seconds = 0;

  filePath = "";
  chunkCount = 0;

  constructor(private cfg: TalkConfig) {
    const m = cfg.listen;
    this.bytesPerChunk = m.sampleRate * (m.bits / 8) * m.channels * m.chunkSeconds;
  }

  get transcriptText(): string {
    return this.lines.map((l) => `[${l.t}] ${l.text}`).join("\n");
  }

  start() {
    if (this.proc) return;
    this.lines = [];
    this.seconds = 0;
    this.chunkCount = 0;
    this.pcm = Buffer.alloc(0);

    const dir = this.resolveDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = join(dir, `listen-${stamp}.md`);
    writeFileSync(this.filePath, `# Listen transcript — ${new Date().toLocaleString()}\n\n`);
    this.refreshWidget();

    const m = this.cfg.listen;
    this.proc = spawn("sox", [
      "-q", "-d",
      "-r", String(m.sampleRate),
      "-c", String(m.channels),
      "-b", String(m.bits),
      "-e", "signed-integer",
      "-t", "raw", "-",
    ]);
    this.proc.stdout.on("data", (d: Buffer) => this.onPcm(d));
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => {
      this.proc = null;
      state.ctx?.ui.notify(`Listen recording failed: ${err.message}`, "error");
    });
    this.proc.on("exit", () => {
      this.proc = null;
    });
  }

  private resolveDir(): string {
    const d = this.cfg.listen.outputDir;
    return d.startsWith("~") ? join(homedir(), d.slice(1)) : d;
  }

  /** Feed raw PCM bytes (called by the sox stdout handler; testable directly). */
  onPcm(data: Buffer) {
    this.pcm = Buffer.concat([this.pcm, data]);
    while (this.pcm.length >= this.bytesPerChunk) {
      const chunk = this.pcm.subarray(0, this.bytesPerChunk);
      this.pcm = this.pcm.subarray(this.bytesPerChunk);
      this.handleChunk(chunk);
    }
  }

  private handleChunk(pcm: Buffer) {
    this.seconds += this.cfg.listen.chunkSeconds;
    if (this.cfg.listen.skipSilence && pcmWindowRms(pcm, this.cfg.listen.sampleRate) < this.cfg.listen.silenceThreshold) {
      return; // genuinely silent: no 100 ms window has energy
    }
    const t = this.formatTime(this.seconds);
    const wav = Buffer.concat([
      wavHeader(pcm.length, this.cfg.listen.sampleRate, this.cfg.listen.channels, this.cfg.listen.bits),
      pcm,
    ]);
    this.queue = this.queue.then(() => this.transcribe(wav, t)).catch(() => {});
  }

  private async transcribe(wav: Buffer, t: string) {
    try {
      const json: any = await this.transcribeRequest(wav, t);
      if (!json) return; // dropped after retries
      if (json.errorStatus) {
        state.ctx?.ui.notify(`Listen transcription failed: ${json.errorStatus}`, "error");
        return;
      }
      const text = String(json?.text ?? "").trim();
      if (!text) return;
      this.lines.push({ t, text });
      this.chunkCount++;
      try {
        appendFileSync(this.filePath, `[${t}] ${text}\n`);
      } catch {
        // persistence is best-effort
      }
      state.listenChunks = this.chunkCount;
      refreshStatus();
      this.refreshWidget();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.ctx?.ui.notify(`Listen transcription failed: ${msg}`, "error");
    }
  }

  /** POST to /audio/transcriptions, with one retry on failure. */
  private async transcribeRequest(wav: Buffer, t: string): Promise<any | null> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const token = readOpenRouterToken();
        const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
          method: "POST",
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.cfg.listen.model,
            input_audio: { data: wav.toString("base64"), format: "wav" },
          }),
        });
        const json: any = await res.json();
        if (!res.ok) {
          const msg = json?.error?.message || `OpenRouter ${res.status}`;
          if (attempt >= 2) return { errorStatus: msg };
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        return json;
      } catch (err) {
        if (attempt >= 2) {
          const msg = err instanceof Error ? err.message : String(err);
          return { errorStatus: msg };
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  stop() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.pcm = Buffer.alloc(0);
    this.refreshWidget();
  }

  /** Kill capture + clear the transcript and widget (used on session reset). */
  reset() {
    this.stop();
    this.lines = [];
    this.seconds = 0;
    this.chunkCount = 0;
    this.clearWidget();
  }

  clearWidget() {
    state.ctx?.ui.setWidget("talk-to-pi-listen", undefined);
  }

  /** Show the most recent transcript lines in a widget above the editor. */
  refreshWidget() {
    const ui = state.ctx?.ui;
    if (!ui) return;
    const max = Math.min(10, Math.max(1, this.cfg.listen.widgetLines));
    const lines = this.lines.slice(-max).map((l) => `[${l.t}] ${l.text}`);
    const header = this.proc ? "📝 listen transcript — live" : "📝 listen transcript — stopped";
    ui.setWidget("talk-to-pi-listen", [header, ...(lines.length ? lines : ["(listening…)"])], {
      placement: "aboveEditor",
    });
  }

  /** Search the transcript; empty query returns the most recent lines. */
  search(query: string, maxLines = 14): string {
    if (this.lines.length === 0) return "No transcript recorded yet.";
    const q = query.trim().toLowerCase();
    if (!q) {
      return this.lines
        .slice(-40)
        .map((l) => `[${l.t}] ${l.text}`)
        .join("\n");
    }
    const hits = this.lines.filter((l) => l.text.toLowerCase().includes(q));
    if (hits.length === 0) return `No lines matching "${query}".`;
    return hits
      .slice(-maxLines)
      .map((l) => `[${l.t}] ${l.text}`)
      .join("\n");
  }

  /** Last `maxChars` characters of the transcript, for context injection. */
  recent(maxChars: number): string {
    const full = this.transcriptText;
    return full.length > maxChars ? full.slice(full.length - maxChars) : full;
  }

  private formatTime(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
}