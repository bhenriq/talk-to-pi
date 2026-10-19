import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** One capture stream (mic or remote tap), sliced into fixed-size PCM chunks. */
class CaptureSource {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pcm = Buffer.alloc(0);

  constructor(
    private bytesPerChunk: number,
    private onChunk: (pcm: Buffer) => void,
    private onError: (msg: string) => void,
    readonly isRemote: boolean,
  ) {}

  start(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d: Buffer) => this.ingest(d));
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => {
      this.proc = null;
      this.onError(err.message);
    });
    this.proc.on("exit", () => {
      this.proc = null;
    });
  }

  stop() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.pcm = Buffer.alloc(0);
  }

  private ingest(data: Buffer) {
    this.pcm = Buffer.concat([this.pcm, data]);
    while (this.pcm.length >= this.bytesPerChunk) {
      const chunk = this.pcm.subarray(0, this.bytesPerChunk);
      this.pcm = this.pcm.subarray(this.bytesPerChunk);
      this.onChunk(chunk);
    }
  }
}

/**
 * Continuous listen recorder: captures one or two sources (mic, and optionally a
 * tap of remote meeting audio), slices each into fixed-length chunks, transcribes
 * via OpenRouter `/api/v1/audio/transcriptions`, and appends to a Markdown file.
 */
export class Listener {
  private sources: CaptureSource[] = [];
  private bytesPerChunk: number;
  private queue: Promise<void> = Promise.resolve();
  private lines: Array<{ t: string; text: string }> = [];
  /** Where the last finished transcript lives, so it stays readable after /listen stops. */
  savedPath: string | null = null;
  private startAt = 0;

  filePath = "";
  chunkCount = 0;

  constructor(private cfg: TalkConfig) {
    const m = cfg.listen;
    this.bytesPerChunk = m.sampleRate * (m.bits / 8) * m.channels * m.chunkSeconds;
  }

  get transcriptText(): string {
    return this.lines.map((l) => `[${l.t}] ${l.text}`).join("\n");
  }

  get startTime(): number {
    return this.startAt;
  }

  start() {
    if (this.sources.length > 0) return;
    this.lines = [];
    this.chunkCount = 0;
    this.savedPath = null; // a new session replaces the searchable transcript
    this.startAt = Date.now();

    const dir = this.resolveDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = join(dir, `listen-${stamp}.md`);
    writeFileSync(this.filePath, `# Listen transcript — ${new Date().toLocaleString()}\n\n`);

    this.addSource(false); // mic
    if (this.cfg.conference.remoteTap && state.conference) this.addSource(true); // remote tap

    this.refreshWidget();
  }

  /** Add or remove the remote tap (called when conference mode toggles). */
  setRemoteTap(active: boolean) {
    if (this.sources.length === 0) return; // not listening
    const hasRemote = this.sources.some((s) => s.isRemote);
    if (active && !hasRemote) {
      this.addSource(true);
    } else if (!active && hasRemote) {
      for (const s of this.sources.filter((s) => s.isRemote)) s.stop();
      this.sources = this.sources.filter((s) => !s.isRemote);
    }
  }

  private addSource(remote: boolean) {
    const m = this.cfg.listen;
    const src = new CaptureSource(
      this.bytesPerChunk,
      (pcm) => this.handleChunk(pcm),
      (msg) => state.ctx?.ui.notify(`Listen recording failed: ${msg}`, "error"),
      remote,
    );
    const base = (command: string, args: string[]) => src.start(command, args);
    if (remote) {
      base("sox", [
        "-q", "-t", "coreaudio", this.cfg.conference.remoteTapDevice,
        "-t", "raw", "-r", String(m.sampleRate), "-c", String(m.channels), "-b", String(m.bits),
        "-e", "signed-integer", "-", "remix", "-m", "1", "2",
      ]);
    } else {
      base("sox", [
        "-q", "-t", "coreaudio", this.cfg.input.micDevice,
        "-r", String(m.sampleRate), "-c", String(m.channels), "-b", String(m.bits),
        "-e", "signed-integer", "-t", "raw", "-",
      ]);
    }
    this.sources.push(src);
  }

  private resolveDir(): string {
    const d = this.cfg.listen.outputDir;
    return d.startsWith("~") ? join(homedir(), d.slice(1)) : d;
  }

  private handleChunk(pcm: Buffer) {
    const t = this.formatTime((Date.now() - this.startAt) / 1000);
    if (this.cfg.listen.skipSilence && pcmWindowRms(pcm, this.cfg.listen.sampleRate) < this.cfg.listen.silenceThreshold) {
      return; // genuinely silent: no 100 ms window has energy
    }
    const wav = Buffer.concat([
      wavHeader(pcm.length, this.cfg.listen.sampleRate, this.cfg.listen.channels, this.cfg.listen.bits),
      pcm,
    ]);
    this.queue = this.queue.then(() => this.transcribe(wav, t)).catch(() => {});
  }

  private async transcribe(wav: Buffer, t: string) {
    try {
      const json: any = await this.transcribeRequest(wav);
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
  private async transcribeRequest(wav: Buffer): Promise<any | null> {
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
    for (const s of this.sources) s.stop();
    this.sources = [];
    // Stopping hides the live transcript from the UI: it is no longer being
    // recorded, so it must not keep sitting above the editor. The lines stay in
    // memory so the save prompt can still summarize them.
    this.clearWidget();
  }

  /**
   * Drop the in-memory transcript (after saving, or on session reset). The file on
   * disk is still reachable through `savedPath`, so `search()` keeps working.
   */
  forget() {
    if (this.filePath) this.savedPath = this.filePath;
    this.lines = [];
    this.chunkCount = 0;
    this.filePath = null;
    this.clearWidget();
  }

  /** Point search at a finalized file (after the save prompt renames it). */
  remember(file: string) {
    this.savedPath = file;
  }

  /** Read a previously saved transcript, so search still works after stopping. */
  private savedLines(): Array<{ t: string; text: string }> {
    if (!this.savedPath || !existsSync(this.savedPath)) return [];
    try {
      return readFileSync(this.savedPath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("[") && l.includes("] "))
        .map((l) => {
          const close = l.indexOf("] ");
          return { t: l.slice(1, close), text: l.slice(close + 2) };
        });
    } catch {
      return [];
    }
  }

  /** Kill capture + clear the transcript and widget (used on session reset). */
  reset() {
    this.stop();
    this.forget();
  }

  clearWidget() {
    state.ctx?.ui.setWidget("talk-to-pi-listen", undefined);
  }

  /** Show only the recent transcript lines (status bar is the listening indicator). */
  refreshWidget() {
    const ui = state.ctx?.ui;
    if (!ui) return;
    // Never repaint the live transcript once capture has stopped: a late chunk or
    // a spoken pi reply must not bring the widget back.
    if (this.sources.length === 0) {
      ui.setWidget("talk-to-pi-listen", undefined);
      return;
    }
    const max = Math.min(10, Math.max(1, this.cfg.listen.widgetLines));
    const lines = this.lines.slice(-max).map((l) => `[${l.t}] ${l.text}`);
    if (lines.length === 0) {
      ui.setWidget("talk-to-pi-listen", undefined);
      return;
    }
    ui.setWidget("talk-to-pi-listen", lines, { placement: "aboveEditor" });
  }

  /** Append pi's spoken sentence to the transcript (the speaker is known exactly). */
  addPiLine(text: string) {
    if (!this.filePath) return; // no active transcript file
    const line = text.trim();
    if (!line) return;
    const t = this.formatTime((Date.now() - this.startAt) / 1000);
    this.lines.push({ t, text: `pi: ${line}` });
    try {
      appendFileSync(this.filePath, `[${t}] pi: ${line}\n`);
    } catch {
      // persistence is best-effort
    }
    this.refreshWidget();
  }

  /** Search the transcript; empty query returns the most recent lines. */
  search(query: string, maxLines = 14): string {
    // Live lines first; after a session settles, fall back to the saved file.
    const source = this.lines.length > 0 ? this.lines : this.savedLines();
    if (source.length === 0) return "No transcript recorded yet.";
    const q = query.trim().toLowerCase();
    if (!q) {
      return source
        .slice(-40)
        .map((l) => `[${l.t}] ${l.text}`)
        .join("\n");
    }
    const hits = source.filter((l) => l.text.toLowerCase().includes(q));
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
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
}