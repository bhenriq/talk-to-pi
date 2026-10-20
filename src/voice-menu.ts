import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Speaker } from "./speaker.ts";

const SPEEDS = [0.8, 0.9, 1.0, 1.1, 1.2];

interface Item {
  kind: "voice" | "speed" | "say-mode";
  label: string;
  value: string | number;
}

/** Overlay menu to pick pi's voice, speed, and /say reply mode. */
export class VoiceMenu implements Component {
  private cursor = 0;
  private items: Item[];

  constructor(
    private tui: TUI,
    private speaker: Speaker,
    private onClose: () => void,
    private notify: (message: string) => void,
    private sayMode: "auto" | "approval",
    private setSayMode: (mode: "auto" | "approval") => void,
  ) {
    const voices: Item[] = speaker.availableVoices().map((v) => ({ kind: "voice", label: v, value: v }));
    const speeds: Item[] = SPEEDS.map((s) => ({ kind: "speed", label: `${s}×`, value: s }));
    const sayModes: Item[] = [
      { kind: "say-mode", label: "auto", value: "auto" },
      { kind: "say-mode", label: "approval", value: "approval" },
    ];
    this.items = [...voices, ...speeds, ...sayModes];
    const idx = this.items.findIndex((i) => i.kind === "voice" && i.value === speaker.getVoice());
    if (idx >= 0) this.cursor = idx;
  }

  private isCurrent(item: Item): boolean {
    if (item.kind === "voice") return item.value === this.speaker.getVoice();
    if (item.kind === "speed") return Math.abs((item.value as number) - this.speaker.getSpeed()) < 0.001;
    return item.value === this.sayMode;
  }

  handleInput(data: string) {
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.cursor = (this.cursor - 1 + this.items.length) % this.items.length;
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.cursor = (this.cursor + 1) % this.items.length;
      this.tui.requestRender();
    } else if (matchesKey(data, "enter")) {
      const item = this.items[this.cursor];
      if (item) this.apply(item);
    } else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.onClose();
    }
  }

  private apply(item: Item) {
    if (item.kind === "voice") {
      this.speaker.setVoice(item.value as string);
      this.notify(`Voice: ${item.value}`);
    } else if (item.kind === "speed") {
      this.speaker.setSpeed(item.value as number);
      this.notify(`Speed: ${item.value}×`);
    } else {
      const mode = item.value as "auto" | "approval";
      this.sayMode = mode; // keep the ✓ marker in sync with the new selection
      this.setSayMode(mode);
      this.notify(`/say mode: ${mode === "auto" ? "speak when ready" : "wait for Enter"}`);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = [" Pi voice, speed & /say", ""];
    const titles: Record<Item["kind"], string> = {
      voice: "Voice",
      speed: "Speed",
      "say-mode": "/say reply",
    };
    let prevKind: Item["kind"] | null = null;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (item.kind !== prevKind) {
        lines.push(` ── ${titles[item.kind]} ──`);
        prevKind = item.kind;
      }
      const cur = i === this.cursor;
      const act = this.isCurrent(item);
      const marker = cur ? "❯ " : act ? "✓ " : "  ";
      lines.push(` ${marker}${item.label}`);
    }
    lines.push("");
    lines.push(" ↑/↓ move · enter set · esc close");
    return lines.map((l) => (l.length > width ? l.slice(0, width) : l));
  }

  invalidate() {}

  dispose() {}
}