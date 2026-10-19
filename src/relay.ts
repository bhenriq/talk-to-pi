import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TalkConfig } from "./config.ts";
import { state } from "./state.ts";

/**
 * Live relay of the physical microphone into the room device (BlackHole) so the
 * meeting hears you, routed with sox (named CoreAudio devices on both ends).
 */
export class Relay {
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(private cfg: TalkConfig) {}

  start() {
    if (this.proc) return;
    const c = this.cfg.conference;
    const gain = Number.isFinite(c.micGain) && c.micGain > 0 ? c.micGain : 1;
    this.proc = spawn("sox", [
      "-q",
      "-t", "coreaudio", this.cfg.input.micDevice,
      "-t", "coreaudio", c.roomDevice,
      "channels", "2", // mic is mono, room device is stereo
      // Balance against pi's voice, which arrives from TTS already normalized.
      ...(Math.abs(gain - 1) > 0.001 ? ["vol", String(gain)] : []),
    ]);
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => {
      this.proc = null;
      state.ctx?.ui.notify(`Conference mic relay failed: ${err.message}`, "error");
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
  }
}