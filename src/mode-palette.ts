import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

export type ModeId = "talk" | "listen" | "conference";

interface ModeItem {
  id: ModeId;
  label: string;
}

const MODES: ModeItem[] = [
  { id: "talk", label: "talk" },
  { id: "listen", label: "listen" },
  { id: "conference", label: "conference" },
];

/** True when every query character appears in `label` in order (fuzzy subsequence). */
function fuzzyMatch(query: string, label: string): boolean {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  let i = 0;
  for (let j = 0; j < l.length && i < q.length; j++) {
    if (l[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Small command palette for toggling talk / listen / conference. */
export class ModePalette implements Component {
  private query = "";
  private cursor = 0;

  constructor(
    private tui: TUI,
    private onClose: () => void,
    private onToggle: (id: ModeId) => void,
    private isOn: (id: ModeId) => boolean,
  ) {}

  private filtered(): ModeItem[] {
    return MODES.filter((m) => fuzzyMatch(this.query, m.label));
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "enter")) {
      const items = this.filtered();
      const item = items[this.cursor] ?? items[0];
      if (item) {
        this.onToggle(item.id);
        this.onClose();
      }
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      const n = Math.max(1, this.filtered().length);
      this.cursor = (this.cursor - 1 + n) % n;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      const n = Math.max(1, this.filtered().length);
      this.cursor = (this.cursor + 1) % n;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.cursor = 0;
      this.tui.requestRender();
      return;
    }
    // A printable character narrows the list.
    if (data.length === 1 && /[a-zA-Z0-9]/.test(data)) {
      this.query += data.toLowerCase();
      this.cursor = 0;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const items = this.filtered();
    const lines = [" Modes", ""];
    lines.push(`  > ${this.query}`);
    lines.push("");
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const cur = i === this.cursor;
      const mark = cur ? "❯" : " ";
      const on = this.isOn(item.id) ? "on" : "off";
      lines.push(` ${mark} ${item.label}  · ${on}`);
    }
    if (items.length === 0) lines.push("   no match");
    lines.push("");
    lines.push(" type to filter · enter toggle · esc close");
    return lines.map((l) => (l.length > width ? l.slice(0, width) : l));
  }

  invalidate() {}

  dispose() {}
}