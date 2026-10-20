import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { conferenceColumn, type TalkConfig } from "./config.ts";
import { state } from "./state.ts";

/**
 * Audible "processing" cue: two very soft notes alternating while pi is waiting
 * (transcribing or thinking). Stops instantly on speech, Esc, or mode off.
 */
export class BusyAudio {
  private playing = false;
  private controller: AbortController | null = null;
  private cues: string[] | null = null;
  private generating: Promise<string[]> | null = null;
  private loop: string | null = null;

  constructor(
    private pi: ExtensionAPI,
    private cfg: TalkConfig,
  ) {}

  setActive(active: boolean) {
    if (!this.cfg.audio.processingCue) return;
    if (active && state.conference && this.cfg.conference.muteBusyCue) return;
    if (active === this.playing) return;
    this.playing = active;
    if (!active) {
      this.controller?.abort();
      this.controller = null;
      return;
    }
    void this.run();
  }

  /**
   * Generate (once) the two soft notes and a long alternating loop. The loop is
   * used in conference mode because the room Multi-Output takes a good part of
   * a second to start flowing; a 0.14s one-shot note is gone before that, but a
   * sustained stream makes it through (a single long-lived sox process, unlike
   * re-opening the device every note).
   */
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
    const gap = join(dir, "gap.aiff");
    const unit = join(dir, "unit.aiff");
    const loop = join(dir, "loop.aiff");
    // 523 Hz (C5) then 659 Hz (E5), gentle envelope, low volume.
    await this.pi.exec("sox", ["-n", "-r", "44100", "-c", "1", a, "synth", "0.14", "sine", "523.25", "vol", "0.5", "fade", "q", "0.004", "0.14", "0.04"]);
    await this.pi.exec("sox", ["-n", "-r", "44100", "-c", "1", b, "synth", "0.14", "sine", "659.25", "vol", "0.45", "fade", "q", "0.004", "0.14", "0.04"]);
    // ~0.51s of silence between notes, matching the local cue rhythm.
    await this.pi.exec("sox", ["-n", "-r", "44100", "-c", "1", gap, "trim", "0", "0.51"]);
    await this.pi.exec("sox", [a, gap, b, gap, unit]);
    await this.pi.exec("sox", [unit, loop, "repeat", "16"]); // ~21s of blips
    this.cues = [a, b];
    this.loop = loop;
    return this.cues;
  }

  private async run() {
    const controller = new AbortController();
    this.controller = controller;
    const cues = await this.ensureCues();
    if (controller.signal.aborted || !this.playing) return;
    let i = 0;
    while (this.playing && !controller.signal.aborted) {
      if (state.conference) {
        // One long-lived stream instead of per-note sox processes: the aggregate
        // only needs to warm up once, so every blip reaches the room.
        try {
          await this.play(this.loop ?? cues[0]!, controller);
        } catch {
          break;
        }
      } else {
        const cue = cues[i % 2]!;
        i++;
        try {
          await this.play(cue, controller);
        } catch {
          break;
        }
        if (controller.signal.aborted) break;
        await this.sleep(this.cfg.audio.intervalMs, controller.signal);
      }
    }
  }

  /**
   * Play one cue file. In conference the cue rides the exact same path as pi's
   * voice (sox → the room Multi-Output), so meeting participants hear the blip
   * too; the `/listen` remote tap (BlackHole 16ch) is not on that path, so the
   * transcript stays clean. Outside conference, afplay to the default output.
   */
  private play(cue: string, controller: AbortController): Promise<unknown> {
    const vol = String(this.cfg.audio.volume);
    const headset = state.headsetConnected;
    if (state.conference) {
      const col = conferenceColumn(this.cfg, headset === true);
      return this.pi.exec("sox", ["-v", vol, cue, "-t", "coreaudio", col.voiceDevice], {
        signal: controller.signal,
      });
    }
    // Local: system default output; see Speaker.playFile for why we never sox to the headset name.
    return this.pi.exec("afplay", ["-v", vol, cue], { signal: controller.signal });
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