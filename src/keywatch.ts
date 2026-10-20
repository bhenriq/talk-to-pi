// Compile and watch the native key-state helper.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface KeyWatcher {
  stop(): void;
}

/** Compile native/keywatcher.m if missing or stale; return the binary path, or null. */
export function getKeyWatcherBinary(): string | null {
  const src = join(__dirname, "..", "native", "keywatcher.m");
  const binDir = join(__dirname, "..", "native", "build");
  const bin = join(binDir, "keywatcher");
  if (!existsSync(src)) return null;
  try {
    if (!existsSync(bin) || statSync(src).mtimeMs > statSync(bin).mtimeMs) {
      mkdirSync(binDir, { recursive: true });
      execSync(
        [
          "clang",
          "-fobjc-arc",
          "-framework", "Foundation",
          "-framework", "CoreGraphics",
          "-framework", "ApplicationServices",
          "-framework", "AppKit",
          "-o", bin,
          src,
        ].join(" "),
        { stdio: "ignore" },
      );
    }
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Spawn the key watcher. `onState` fires with `true`/`false` on every state change.
 * The first line reports the key's current state.
 */
export function watchKey(
  bin: string,
  keycode: number,
  pollMs: number,
  terminalBundleIds: string[],
  onState: (down: boolean) => void,
): KeyWatcher {
  const args = [String(keycode), String(pollMs)];
  if (terminalBundleIds.length > 0) args.push(terminalBundleIds.join(","));
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const t = line.trim();
      if (t === "0") onState(false);
      else if (t === "1") onState(true);
    }
  });
  proc.on("error", () => {});
  return {
    stop() {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    },
  };
}