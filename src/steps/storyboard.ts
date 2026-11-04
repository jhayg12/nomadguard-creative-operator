import type { Brief, Storyboard, Strategy } from "../schemas.js";
import { StoryboardSchema, storyboardRules, MAX_GENERATED_SECONDS, MIN_GENERATED_SECONDS } from "../schemas.js";
import { generateValidated, type StructuredLlm } from "../llm.js";

const SYSTEM = `You are a commercial director turning an approved concept into a shot list for an AI video model
(Kling v3, multi-shot mode: all shots are rendered in ONE generation, so the same person carries through).

Rules for video_prompt (one per shot):
- Photorealistic live-action commercial look. Describe subject, action, setting, camera move, lighting.
- Repeat the traveler's key identifying details (age, hair, outfit) in EVERY shot prompt so identity stays locked.
- One clear action per shot. Avoid hands doing fine manipulation, fast complex motion, crowds in focus.
- NO readable text, logos, app UI, signage words or numbers in the frame (garbled AI text kills trust). Phone screens should glow, angled away or out of focus.
- Shot 1 is the hook: open IN the disruption moment with a close or dramatic framing, no slow establishing shot.
- Final shot resolves with calm confidence (relief, smile, walking on) and leaves clean negative space in the upper or middle third for the end card.

on_screen_text: short punchy overlay (max ~6 words) that the editor burns in; it carries the message with sound off.
Leave it empty when the image says enough. Do NOT put the brand name in the scenes; it appears on the end card.`;

export async function buildStoryboard(
  llm: StructuredLlm,
  brief: Brief,
  strategy: Strategy,
): Promise<Storyboard> {
  const angle = strategy.angles[strategy.selected_index];
  return generateValidated(
    llm,
    {
      label: "storyboard",
      system: SYSTEM,
      schema: StoryboardSchema,
      content: `Brief:
${JSON.stringify(brief, null, 2)}

Selected angle:
${JSON.stringify(angle, null, 2)}
Why it was selected: ${strategy.selection.why_selected}

Write 4 shots (3-5 allowed). Shot durations are whole seconds (2-5s each, shot 1 <= 3s) and must total ${MIN_GENERATED_SECONDS}-${MAX_GENERATED_SECONDS}s;
a 2s branded end card is added in editing.
Vertical 9:16, Instagram Reels / TikTok. Brand feel: ${brief.brand_feel.join(", ")}.`,
    },
    storyboardRules,
  );
}
