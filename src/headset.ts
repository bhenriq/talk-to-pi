import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TalkConfig } from "./config.ts";
import { refreshStatus, state } from "./state.ts";
import { probeDevice } from "./system-audio.ts";

const POLL_MS = 3000;

/**
 * Watches one audio device (the headset) and reports whether it is actually
 * connected. A Bluetooth headset that is switched off vanishes from CoreAudio's
 * device list, so presence + alive + output streams is a reliable answer.
 *
 * Only probes while a voice mode is on, so an idle pi session costs nothing.
 */
export class HeadsetWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private lastNotified: boolean | null = null;

  constructor(
    private pi: ExtensionAPI,
    private cfg: TalkConfig,
    private onChange?: (connected: boolean) => void,
  ) {}

  start() {
    if (this.timer || !this.cfg.audio.headsetDevice) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    state.headsetConnected = null;
    refreshStatus();
  }

  private active(): boolean {
    return state.enabled || state.conference;
  }

  private async poll() {
    if (this.inFlight) return;
    if (!this.active()) {
      // Drop the indicator when no mode is on; no need to keep probing.
      if (state.headsetConnected !== null) {
        state.headsetConnected = null;
        this.lastNotified = null;
        refreshStatus();
      }
      return;
    }
    this.inFlight = true;
    try {
      const probe = await probeDevice(this.pi, this.cfg.audio.headsetDevice);
      if (!probe) return; // helper unavailable: stay silent rather than lie
      const connected = probe.present && probe.alive && probe.outStreams > 0;
      if (connected !== state.headsetConnected) {
        state.headsetConnected = connected;
        refreshStatus();
        this.onChange?.(connected);
      }
      if (this.lastNotified !== null && this.lastNotified !== connected) {
        const name = this.cfg.audio.headsetDevice;
        state.ctx?.ui.notify(
          connected ? `${name} connected` : `${name} disconnected — audio now uses the system output`,
          connected ? "info" : "warning",
        );
      }
      this.lastNotified = connected;
    } catch {
      // probing is best-effort; never break a voice session over it
    } finally {
      this.inFlight = false;
    }
  }
}
