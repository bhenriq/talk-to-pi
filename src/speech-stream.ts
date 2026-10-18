// Incremental markdown → speech text, with fenced-code-block skipping and
// sentence splitting. `feed()` receives the full accumulated assistant text and
// returns newly completed sentences.

function cleanLine(line: string): string {
  let s = line;
  s = s.replace(/^\s{0,3}(#{1,6})\s+/, ""); // atx headings
  s = s.replace(/^\s{0,3}[>]\s?/, ""); // blockquote
  s = s.replace(/^\s*[-*+]\s+/, ""); // bullet list
  s = s.replace(/^\s*\d+[.)]\s+/, ""); // numbered list
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1"); // bold
  s = s.replace(/__([^_]+)__/g, "$1"); // bold underscore
  s = s.replace(/~~([^~]+)~~/g, "$1"); // strikethrough
  s = s.replace(/`([^`]*)`/g, "$1"); // inline code
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); // images -> nothing
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links -> text
  s = s.replace(/\|/g, " "); // table pipes
  s = s.replace(/\s+/g, " "); // collapse whitespace
  return s;
}

export class SpeechStream {
  private buf = "";
  private inFence = false;
  private rawLen = 0;
  private started = false;
  private scanFrom = 0;

  reset() {
    this.buf = "";
    this.inFence = false;
    this.rawLen = 0;
    this.started = false;
    this.scanFrom = 0;
  }

  /** Feed the full accumulated raw assistant text; returns finished sentences. */
  feed(rawFull: string): string[] {
    if (!this.started) {
      this.started = true;
      this.rawLen = 0;
    }
    const tail = rawFull.slice(this.rawLen);
    this.rawLen = rawFull.length;
    this.buf += this.stripTail(tail);
    return this.extractSentences();
  }

  /** Flush whatever remains (no trailing punctuation) as a final sentence. */
  flush(): string[] {
    const out = this.extractSentences();
    const rest = this.buf.trim();
    this.buf = "";
    this.scanFrom = 0;
    if (rest) out.push(rest);
    return out;
  }

  private stripTail(s: string): string {
    let out = "";
    for (const line of s.split("\n")) {
      if (/^\s*```/.test(line)) {
        this.inFence = !this.inFence;
        continue;
      }
      if (this.inFence) continue;
      out += cleanLine(line) + " ";
    }
    return out;
  }

  private extractSentences(): string[] {
    const out: string[] = [];
    let guard = 0;
    while (guard++ < 400) {
      const re = /[.!?]+/g;
      re.lastIndex = this.scanFrom;
      const m = re.exec(this.buf);
      if (!m) {
        // No (more) punctuation: nothing to split. Trim waste whitespace.
        this.buf = this.buf.replace(/^[ \t]+/, "");
        this.scanFrom = 0;
        break;
      }
      const end = m.index + m[0].length;
      const after = this.buf.slice(end);
      if (after.trim() === "") {
        // Trailing punctuation: re-examine this same punctuation once more text arrives.
        this.scanFrom = m.index;
        break;
      }
      const capitalized = /^[ \t]*[A-Z0-9"“'(>]/.test(after);
      if (capitalized) {
        out.push(this.buf.slice(0, end).trim());
        this.buf = after.replace(/^[ \t]+/, "");
        this.scanFrom = 0;
      } else {
        // Likely abbreviation/decimal (e.g. "e.g.", "3.14"): skip and keep scanning.
        this.scanFrom = end;
      }
    }
    return out.filter((s) => s.length > 0);
  }
}