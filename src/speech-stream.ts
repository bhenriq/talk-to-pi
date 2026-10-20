// Incremental markdown → speech text.
//
// `feed()` receives the FULL accumulated assistant text on every update and
// re-cleans the whole thing from scratch, then only emits sentences it has not
// emitted yet. Re-cleaning the full text (instead of diffing stream deltas)
// means chunk boundaries can never corrupt a word: "Octo" + "puses" is cleaned as
// one pass over the joined text, so it stays "Octopuses".

/** Remove the space streaming tokenizers leave before punctuation. */
function cleanPunctuation(s: string): string {
  return s.replace(/\s+([,.!?;:])/g, "$1").trim();
}

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
  // Collapse whitespace and drop the space streamed before punctuation.
  s = s.replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  return s;
}

/** Stateless clean of the whole raw markdown text (fences stripped, lines joined). */
function cleanFull(raw: string): string {
  let out = "";
  let inFence = false;
  for (const line of raw.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const cleaned = cleanLine(line);
    if (cleaned) out += cleaned + " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

export class SpeechStream {
  private cleaned = "";
  private emitted = 0; // index in `cleaned` up to which sentences were already emitted

  reset() {
    this.cleaned = "";
    this.emitted = 0;
  }

  /** Feed the full accumulated raw assistant text; returns newly finished sentences. */
  feed(rawFull: string): string[] {
    this.cleaned = cleanFull(rawFull);
    return this.extractNewSentences();
  }

  /** Flush whatever remains (possibly without trailing punctuation) as a final sentence. */
  flush(): string[] {
    const out = this.extractNewSentences();
    const rest = cleanPunctuation(this.cleaned.slice(this.emitted));
    this.emitted = this.cleaned.length;
    if (rest) out.push(rest);
    return out;
  }

  /** Emit complete sentences that start after `emitted` and end in punctuation. */
  private extractNewSentences(): string[] {
    const out: string[] = [];
    let guard = 0;
    let from = this.emitted;
    while (guard++ < 400) {
      const re = /[.!?]+/g;
      re.lastIndex = from;
      const m = re.exec(this.cleaned);
      if (!m) break;
      const end = m.index + m[0].length;
      const after = this.cleaned.slice(end);
      if (after.trim() === "") {
        // Trailing punctuation: wait for more text before deciding it is a full stop.
        break;
      }
      const capitalized = /^[ \t]*[A-Z0-9""'(>]/.test(after);
      if (!capitalized) {
        // Abbreviation/decimal (e.g. "e.g.", "3.14"): keep scanning.
        from = end;
        continue;
      }
      const sentence = cleanPunctuation(this.cleaned.slice(this.emitted, end));
      this.emitted = end;
      from = end;
      if (sentence) out.push(sentence);
    }
    return out;
  }
}