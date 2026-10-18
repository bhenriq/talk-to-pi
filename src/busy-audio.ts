import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TalkConfig } from "./config.ts";

/**
 * Audible "processing" cue: two very soft notes alternating while pi is waiting
 * (transcribing or thinking). Stops instantly on speech, Esc, or mode off.
 */
export class BusyAudio {
  private playing = false;
  private controller: AbortController | null = null;
  private cues: string[] | null = null;
  private generating: Promise<string[]> | null = null;

  constructor(
    private pi: ExtensionAPI,
    private cfg: TalkConfig,
  ) {}

  setActive(active: boolean) {
    if (!this.cfg.audio.processingCue) return;
    if (active === this.playing) return;
    this.playing = active;
    if (!active) {
      this.controller?.abort();
      this.controller = null;
      return;
    }
    void this.run();
  }

  /** Generate (once) two soft sine blips with sox. */
  private ensureCues(): Promise<string[]> {
    if (this.cues) return Promise.resolve(this.cues);
    if (!this.generating) this.generating = this.generate();
    return this.generating;
  }

  private async generate(): Promise<string[]> {
    const dir = join(tmpdir(), "talk-to-pi", "cues");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "note-a.aiff");
    const b = join(dir, "note-b.aiff");
    // 523 Hz (C5) then 659 Hz (E5), gentle envelope, low volume via afplay -v.
    await this.pi.exec("sox", ["-n", "-r", "44100", "-c", "1", a, "synth", "0.14", "sine", "523.25", "vol", "0.5", "fade", "q", "0.004", "0.14", "0.04"]);
    await this.pi.exec("sox", ["-n", "-r", "44100", "-c", "1", b, "synth", "0.14", "sine", "659.25", "vol", "0.45", "fade", "q", "0.004", "0.14", "0.04"]);
    this.cues = [a, b];
    return this.cues;
  }

  private async run() {
    const controller = new AbortController();
    this.controller = controller;
    const cues = await this.ensureCues();
    if (controller.signal.aborted || !this.playing) return;
    let i = 0;
    while (this.playing && !controller.signal.aborted) {
      const cue = cues[i % 2]!;
      i++;
      try {
        await this.pi.exec("afplay", ["-v", String(this.cfg.audio.volume), cue], { signal: controller.signal });
      } catch {
        break;
      }
      if (controller.signal.aborted) break;
      await this.sleep(this.cfg.audio.intervalMs, controller.signal);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}