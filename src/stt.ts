import { readFileSync, rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TalkConfig } from "./config.ts";
import { readOpenRouterToken } from "./openrouter.ts";

const STT_PROMPT = "Transcribe the audio verbatim. Output only the transcript text, nothing else.";

/** Transcribe a 16-bit mono WAV via OpenRouter input_audio, then delete the file. */
export async function transcribeWav(pi: ExtensionAPI, cfg: TalkConfig, wavPath: string): Promise<string> {
  try {
    const b64 = readFileSync(wavPath).toString("base64");
    const token = readOpenRouterToken();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.stt.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: STT_PROMPT },
              { type: "input_audio", input_audio: { data: b64, format: "wav" } },
            ],
          },
        ],
        max_tokens: 512,
        temperature: 0,
      }),
    });
    const json: any = await res.json();
    if (!res.ok) {
      throw new Error(json?.error?.message || `OpenRouter ${res.status}`);
    }
    return String(json?.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    try {
      rmSync(wavPath, { force: true });
    } catch {
      // temp file cleanup is best-effort
    }
  }
}