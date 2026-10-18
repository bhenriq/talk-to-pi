import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TalkConfig } from "./config.ts";
import { getKeyWatcherBinary, watchKey, type KeyWatcher } from "./keywatch.ts";
import { refreshStatus, state } from "./state.ts";

export interface RecorderEvents {
  onCompleted: (wavPath: string, durationMs: number) => void;
  onDiscarded: () => void;
}

const MAX_AUTOREPEAT_FALLBACK_MS = 30_000;

/**
 * Records from the default mic while the talk key is held, using sox for capture
 * and (preferring) a native key-state poll for precise release detection.
 */
export class Recorder {
  private controller: AbortController | null = null;
  private watcher: KeyWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private file = "";
  private startedAt = 0;
  private lastRepeatAt = 0;
  private repeatCount = 0;
  private nativeArmed = false;
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
    this.lastRepeatAt = Date.now();
    this.repeatCount = 0;
    this.nativeArmed = false;
    this.done = false;

    this.soxDone = this.pi
      .exec(
        "sox",
        [
          "-q",
          "-t", "coreaudio", this.cfg.input.micDevice,
          "-r",
          String(this.cfg.stt.sampleRate),
          "-c",
          String(this.cfg.stt.channels),
          "-b",
          String(this.cfg.stt.bits),
          this.file,
        ],
        { signal: this.controller.signal },
      )
      .catch(() => {});

    this.startNativeWatcher();
    this.timer = setInterval(() => this.checkFallback(), 50);
  }

  /** Terminal delivered another space event (autorepeat) while recording. */
  onSpaceEvent() {
    if (this.done) return;
    this.repeatCount++;
    this.lastRepeatAt = Date.now();
  }

  private startNativeWatcher() {
    const bin = getKeyWatcherBinary();
    if (!bin) return;
    try {
      this.watcher = watchKey(bin, this.cfg.input.keyCode, this.cfg.input.pollMs, (down) => {
        if (this.done) return;
        if (down) {
          this.nativeArmed = true;
        } else if (this.nativeArmed) {
          void this.release();
        }
      });
    } catch {
      this.watcher = null;
    }
  }

  private checkFallback() {
    if (this.done || !this.controller) return;
    if (this.nativeArmed) return; // native poll is authoritative once proven
    const held = Date.now() - this.startedAt;
    const silence = Date.now() - this.lastRepeatAt;
    if (this.repeatCount >= 2 && silence >= this.cfg.input.repeatSilenceMs && held >= this.cfg.input.minRecordingMs) {
      void this.release();
    } else if (held >= MAX_AUTOREPEAT_FALLBACK_MS) {
      void this.release();
    }
  }

  private stopStreams() {
    this.watcher?.stop();
    this.watcher = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
  }

  /** Release detected: stop capture and deliver the wav. */
  private async release() {
    if (this.done) return;
    this.done = true;
    const duration = Date.now() - this.startedAt;
    this.stopStreams();
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
    this.stopStreams();
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