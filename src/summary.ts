import type { TalkConfig } from "./config.ts";
import { openRouterChat } from "./openrouter.ts";

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "meeting"
  );
}

/** Ask the model for a slug + bullet summary of the meeting transcript. */
export async function summarizeMeeting(cfg: TalkConfig, transcript: string): Promise<{ slug: string; summary: string }> {
  const truncated = transcript.length > 8000 ? transcript.slice(-8000) : transcript;
  const prompt =
    "Here is a meeting transcript (HH:MM:SS per line; lines prefixed \"pi:\" are the assistant).\n" +
    "Produce a SHORT slug (3-6 words, kebab-case) summarizing the meeting, and a concise summary of 3-5 bullets.\n" +
    "Respond with the slug on the first line starting with \"SLUG:\", then bullet points each on their own line starting with \"- \":\n\n" +
    "Transcript:\n" +
    truncated;

  let slug = "";
  const bullets: string[] = [];
  try {
    const raw = await openRouterChat(
      cfg.listen.summaryModel,
      "You summarize meetings. Output a kebab-case slug then bullet points, nothing else.",
      prompt,
      400,
    );
    for (const line of raw.split("\n")) {
      const t = line.trim();
      const m = /^slug[*:\s]+(.+)$/i.exec(t);
      if (m) {
        slug = slugify(m[1]);
        continue;
      }
      if (/^[-*•]\s*/.test(t)) bullets.push(t);
    }
  } catch {
    // fall through to defaults below
  }

  if (!slug) slug = "meeting";
  if (bullets.length === 0) {
    bullets.push("- " + truncated.slice(0, 200).replace(/\s+/g, " "));
  }
  return { slug, summary: bullets.join("\n") };
}