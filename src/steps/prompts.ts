import { PipelineError } from "../errors.js";
import type { Storyboard } from "../schemas.js";
import type { VideoRequest } from "../providers/VideoProvider.js";

/**
 * Storyboard -> provider request. Kept separate from the storyboard step so the same storyboard can be
 * re-targeted to another model's prompt style.
 *
 * Each shot prompt = storyboard shot prompt (opens with the same identity tag every shot)
 * + realism suffix. Prompts are kept compact because Kling's multi-shot
 * prompts are short; long prompts get truncated or rejected, after you've paid.
 */
const REALISM = "Photorealistic live-action commercial, natural skin texture, film grain.";

/** Kling v3 multi-shot hard limit per shot (fal returns 422 above it). Checked before any submission. */
export const MAX_PROVIDER_PROMPT_CHARS = 512;

export const NEGATIVE_PROMPT =
  "text, letters, words, subtitles, captions, logo, watermark, readable signage, UI, numbers, " +
  "distorted face, extra fingers, deformed hands, cartoon, CGI, 3d render, low quality, blur, flicker, morphing";

export function buildVideoRequest(sb: Storyboard): VideoRequest {
  // The storyboard's shot prompts already carry the identity tag + action/camera (kept short on purpose).
  // Here we add only the realism suffix. QA feedback goes back through the storyboard step, not in here.
  // The style bible's colour grade is
  // NOT appended: it describes the whole arc (e.g. night -> morning), and pasting it into every shot told the
  // night shots to be golden morning. Each shot prompt carries its own lighting instead.
  const shots = sb.scenes.map((s) => ({
    durationSec: s.duration,
    prompt: `${s.video_prompt.trim()} ${REALISM}`,
  }));
  const tooLong = shots.findIndex((s) => s.prompt.length > MAX_PROVIDER_PROMPT_CHARS);
  if (tooLong >= 0)
    throw new PipelineError(
      `shot ${tooLong + 1} prompt is ${shots[tooLong].prompt.length} chars (max ${MAX_PROVIDER_PROMPT_CHARS}); refusing to submit a paid render`,
      { retryable: false },
    );
  return { aspectRatio: "9:16", audio: true, negativePrompt: NEGATIVE_PROMPT, shots };
}
