import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TalkConfig } from "./config.ts";
import { refreshStatus, state } from "./state.ts";

export interface RecorderEvents {
  onCompleted: (wavPath: string, durationMs: number) => void;
  onDiscarded: () => void;
}

/**
 * Records from the configured mic while the (native) talk key is held, using sox.
 * Down/up detection lives in index.ts (the talk key is polled natively); this class
 * only owns the capture stream.
 */
export class Recorder {
  private controller: AbortController | null = null;
  private file = "";
  private startedAt = 0;
  private done = true; // idle until start()
  private soxDone: Promise<unknown> | null = null;

  constructor(
    private pi: ExtensionAPI,
    private cfg: TalkConfig,
    private events: RecorderEvents,
  ) {}

  start() {
    if (!this.done) return; // already recording
    this.file = join(tmpdir(), "talk-to-pi", `talk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    mkdirSync(join(tmpdir(), "talk-to-pi"), { recursive: true });
    this.controller = new AbortController();
    this.startedAt = Date.now();
    this.done = false;

    this.soxDone = this.pi
      .exec(
        "sox",
        [
          "-q",
          "-t", "coreaudio", this.cfg.input.micDevice,
          "-r", String(this.cfg.stt.sampleRate),
          "-c", String(this.cfg.stt.channels),
          "-b", String(this.cfg.stt.bits),
          this.file,
        ],
        { signal: this.controller.signal },
      )
      .catch(() => {});
  }

  /** Talk key released: stop capture and deliver the wav (if long enough). */
  async release() {
    if (this.done) return;
    this.done = true;
    const duration = Date.now() - this.startedAt;
    this.controller?.abort();
    await this.soxDone;
    state.recording = false;
    refreshStatus();
    if (duration < this.cfg.input.minRecordingMs) {
      this.removeFile();
      this.events.onDiscarded();
      return;
    }
    this.events.onCompleted(this.file, duration);
  }

  /** Esc while recording: kill capture, discard everything. */
  cancel() {
    if (this.done) return;
    this.done = true;
    this.controller?.abort();
    state.recording = false;
    refreshStatus();
    this.events.onDiscarded();
    this.removeFile();
    void this.soxDone?.then(() => this.removeFile());
  }

  private removeFile() {
    try {
      rmSync(this.file, { force: true });
    } catch {
      // best-effort
    }
  }
}