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

export interface DeviceProbe {
  present: boolean;
  alive: boolean;
  outStreams: number;
  inStreams: number;
  rate: number;
  transport: number;
}

/**
 * Ask CoreAudio about one device by name. A Bluetooth headset that is powered off
 * does not appear in the device list at all, so `present` alone answers
 * "is my headset connected?"; `alive`/`outStreams` guard the in-between states.
 */
export async function probeDevice(pi: ExtensionAPI, name: string): Promise<DeviceProbe | null> {
  const bin = getAudioDefaultBinary();
  if (!bin || !name) return null;
  const res = await pi.exec(bin, ["probe", name]);
  if (res.code !== 0) return null;
  const facts: Record<string, string> = {};
  for (const line of res.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) facts[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const num = (k: string) => Number(facts[k] ?? 0) || 0;
  return {
    present: facts.present === "1",
    alive: facts.alive === "1",
    outStreams: num("outStreams"),
    inStreams: num("inStreams"),
    rate: num("rate"),
    transport: num("transport"),
  };
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