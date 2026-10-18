import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Read the OpenRouter OAuth access token from ~/.pi/agent/auth.json. */
export function readOpenRouterToken(): string {
  const p = join(homedir(), ".pi", "agent", "auth.json");
  const auth = JSON.parse(readFileSync(p, "utf8"));
  const token: unknown = auth?.openrouter?.access;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("openrouter OAuth token not found in ~/.pi/agent/auth.json");
  }
  return token;
}