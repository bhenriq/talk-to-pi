// Compile and run the audio-default native helper (get/set macOS default audio device).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getAudioDefaultBinary(): string | null {
  const src = join(__dirname, "..", "native", "audio-default.m");
  const binDir = join(__dirname, "..", "native", "build");
  const bin = join(binDir, "audio-default");
  if (!existsSync(src)) return null;
  try {
    if (!existsSync(bin) || statSync(src).mtimeMs > statSync(bin).mtimeMs) {
      mkdirSync(binDir, { recursive: true });
      execSync(`clang -fobjc-arc -framework CoreAudio -framework Foundation -o "${bin}" "${src}"`, { stdio: "ignore" });
    }
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export async function getDefaultDevice(pi: ExtensionAPI, type: "input" | "output"): Promise<string> {
  const bin = getAudioDefaultBinary();
  if (!bin) throw new Error("audio-default helper unavailable");
  const res = await pi.exec(bin, ["get", type]);
  return res.stdout.trim();
}

export async function setDefaultDevice(pi: ExtensionAPI, type: "input" | "output", name: string): Promise<void> {
  const bin = getAudioDefaultBinary();
  if (!bin) throw new Error("audio-default helper unavailable");
  const res = await pi.exec(bin, ["set", type, name]);
  if (res.code !== 0) {
    throw new Error(res.stderr?.trim() || `failed to set ${type} to ${name}`);
  }
}