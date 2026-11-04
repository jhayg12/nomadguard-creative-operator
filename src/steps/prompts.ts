import type { Storyboard } from "../schemas.js";
import type { VideoRequest } from "../providers/VideoProvider.js";

/**
 * Storyboard -> provider request. Kept separate from the storyboard step so the same storyboard can be
 * re-targeted to another model's prompt style, and so QA notes can be injected on a regeneration.
 *
 * Each shot prompt = shot action + camera + the shared style bible (identity/wardrobe/grade/lens)
 * + realism suffix. Repeating the bible per shot is what keeps the traveler consistent across cuts.
 */
const REALISM =
  "Photorealistic live-action commercial, shot on a cinema camera, natural skin texture, realistic hands, " +
  "shallow depth of field, subtle film grain, premium brand film look.";

export const NEGATIVE_PROMPT =
  "text, letters, words, subtitles, captions, logo, watermark, readable signage, UI, numbers, " +
  "distorted face, extra fingers, deformed hands, cartoon, CGI, 3d render, low quality, blur, flicker, morphing";

export function buildVideoRequest(sb: Storyboard, qaNotes?: string): VideoRequest {
  const bible = sb.style_bible;
  const identity = `Same person in every shot: ${bible.character}. Wearing ${bible.wardrobe}.`;
  const look = `Setting: ${bible.setting}. Color grade: ${bible.color_grade}. ${bible.lens_and_light}.`;
  const fix = qaNotes?.trim() ? ` Avoid previous issues: ${qaNotes.trim()}` : "";

  return {
    aspectRatio: "9:16",
    audio: true,
    negativePrompt: NEGATIVE_PROMPT,
    shots: sb.scenes.map((s) => ({
      durationSec: s.duration,
      prompt: `${s.video_prompt} Camera: ${s.camera}. ${identity} ${look} ${REALISM} Sound: ${sb.sound}.${fix}`,
    })),
  };
}
