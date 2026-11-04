import { copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ffprobeJson } from "../ffmpeg.js";
import { PipelineError } from "../errors.js";
import { generateValidated, type StructuredLlm } from "../llm.js";
import type { AudioProvider } from "../providers/AudioProvider.js";
import { AudioPlanSchema, audioPlanRules, type AudioPlan, type Brief, type Storyboard } from "../schemas.js";

const SYSTEM = `You are the sound designer and copywriter for a 10-15s paid social ad (Reels/TikTok).
Write a voice-over that ADDS to the on-screen captions instead of repeating them word for word:
calm, confident, human, second person, short sentences. It must end on the brand name and promise,
which lands during the end card. Then brief an instrumental music bed that supports the story arc
(tension at the start, warm resolve) without competing with the voice.`;

export const VO_START_SECONDS = 0.4;

export async function planAudio(llm: StructuredLlm, brief: Brief, sb: Storyboard, totalSeconds: number): Promise<AudioPlan> {
  return generateValidated(
    llm,
    {
      label: "audio-plan",
      system: SYSTEM,
      schema: AudioPlanSchema,
      content: `Brief core message: "${brief.core_message}". Brand: ${brief.brand}. Feel: ${brief.brand_feel.join(", ")}.
Shots (with burned-in captions):
${sb.scenes.map((s, i) => `${i + 1}. ${s.duration}s - ${s.description} | caption: "${s.on_screen_text}"`).join("\n")}
End card: ${sb.end_card.headline} / ${sb.end_card.cta}
Total ad length: ${totalSeconds.toFixed(1)}s. The voice starts at ${VO_START_SECONDS}s and must finish before the end.`,
    },
    audioPlanRules(totalSeconds - VO_START_SECONDS, brief.brand),
  );
}

export async function download(url: string, dest: string) {
  if (url.startsWith("file:")) return copyFile(fileURLToPath(url), dest);
  const res = await fetch(url);
  if (!res.ok) throw new PipelineError(`download failed: HTTP ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export async function durationOf(file: string) {
  return Number((await ffprobeJson(file)).format.duration);
}

/** Synthesize the VO; if it runs long, retry once slightly faster, then give up loudly rather than cut words off. */
export async function synthesizeVoiceover(audio: AudioProvider, plan: AudioPlan, dest: string, maxSeconds: number) {
  for (const speed of [1, 1.12]) {
    const r = await audio.speech({ text: plan.voiceover, speed });
    await download(r.url, dest);
    const d = await durationOf(dest);
    if (d <= maxSeconds) return d;
  }
  throw new PipelineError(`voice-over runs longer than ${maxSeconds.toFixed(1)}s even at 1.12x; shorten the script`, {
    retryable: false,
    resumeFrom: "SCORING",
  });
}
