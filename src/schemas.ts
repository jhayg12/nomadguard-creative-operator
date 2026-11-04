import { z } from "zod";

// ---------- Brief ----------
export const BriefSchema = z.object({
  brand: z.string(),
  product: z.string(),
  audience: z.string(),
  problem: z.array(z.string()),
  core_message: z.string(),
  brand_feel: z.array(z.string()),
  format: z.object({
    platforms: z.array(z.string()),
    aspect_ratio: z.literal("9:16"),
    min_seconds: z.number(),
    max_seconds: z.number(),
  }),
});
export type Brief = z.infer<typeof BriefSchema>;

// ---------- Part 1: strategy ----------
export const AngleSchema = z.object({
  name: z.string(),
  target_emotion: z.string(),
  hook: z.string().describe("What happens on screen in the first 2-3 seconds"),
  concept: z.string(),
  cta: z.string(),
});

export const StrategySchema = z.object({
  angles: z.array(AngleSchema),
  selected_index: z.number().int(),
  selection: z.object({
    why_selected: z.string(),
    audience_insight: z.string(),
    why_it_works_on_social: z.string(),
  }),
});
export type Strategy = z.infer<typeof StrategySchema>;

/** Rules the JSON schema can't express. Returned strings are fed back to the model on retry. */
export function strategyRules(s: Strategy): string[] {
  const errors: string[] = [];
  if (s.angles.length < 3) errors.push(`Need at least 3 angles, got ${s.angles.length}.`);
  if (s.selected_index < 0 || s.selected_index >= s.angles.length)
    errors.push(`selected_index ${s.selected_index} is out of range 0..${s.angles.length - 1}.`);
  const names = new Set(s.angles.map((a) => a.name.trim().toLowerCase()));
  if (names.size !== s.angles.length) errors.push("Angle names must be distinct.");
  return errors;
}

// ---------- Part 2: storyboard ----------
export const SceneSchema = z.object({
  duration: z.number().int().describe("Whole seconds, 2-5"),
  description: z.string(),
  camera: z.string(),
  on_screen_text: z
    .string()
    .describe("Short overlay text burned in during editing (max ~6 words), or empty string for none"),
  video_prompt: z
    .string()
    .describe("Compact shot prompt (max 400 chars): short identity tag + action + setting + camera + light. No text or logos"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardSchema = z.object({
  title: z.string(),
  style_bible: z.object({
    character: z.string().describe("One recurring traveler: age, look, hair, build"),
    wardrobe: z.string(),
    setting: z.string(),
    color_grade: z.string(),
    lens_and_light: z.string(),
  }),
  scenes: z.array(SceneSchema),
  end_card: z.object({
    headline: z.string(),
    cta: z.string(),
  }),
  sound: z.string().describe("Ambient sound / music direction for the native audio track"),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/** Kling multi-shot rejects shot prompts over 512 chars (fal 422). Leave room for the builder's realism suffix. */
export const MAX_SHOT_PROMPT_CHARS = 430;

/** Generated footage must leave room for a ~2s end card inside the 10-15s limit. */
export const END_CARD_SECONDS = 2;
export const MAX_GENERATED_SECONDS = 12; // providers overshoot slightly (Kling: +0.04s)
export const MIN_GENERATED_SECONDS = 9;

export function storyboardRules(s: Storyboard): string[] {
  const errors: string[] = [];
  if (s.scenes.length < 3 || s.scenes.length > 5)
    errors.push(`Use 3-5 scenes, got ${s.scenes.length}.`);
  s.scenes.forEach((sc, i) => {
    if (sc.duration < 2 || sc.duration > 5) errors.push(`Scene ${i + 1} duration ${sc.duration}s must be 2-5s.`);
    if (sc.video_prompt.length > MAX_SHOT_PROMPT_CHARS)
      errors.push(`Scene ${i + 1} video_prompt is ${sc.video_prompt.length} chars; keep it under ${MAX_SHOT_PROMPT_CHARS}.`);
    if (sc.on_screen_text.split(/\s+/).filter(Boolean).length > 7)
      errors.push(`Scene ${i + 1} on_screen_text is too long for a phone screen (max ~6 words).`);
  });
  const total = s.scenes.reduce((t, sc) => t + sc.duration, 0);
  if (total < MIN_GENERATED_SECONDS || total > MAX_GENERATED_SECONDS)
    errors.push(
      `Scene durations add up to ${total}s; they must total ${MIN_GENERATED_SECONDS}-${MAX_GENERATED_SECONDS}s so the ad plus a ${END_CARD_SECONDS}s end card stays within 10-15s.`,
    );
  if (s.scenes[0] && s.scenes[0].duration > 3) errors.push("Scene 1 is the hook and must be 3s or shorter.");
  return errors;
}

// ---------- Part 6: QA ----------
export const TechnicalQASchema = z.object({
  exists: z.boolean(),
  playable: z.boolean(),
  duration: z.number().nullable(),
  resolution: z.string().nullable(),
  aspect_ratio: z.string().nullable(),
  has_audio: z.boolean(),
  valid: z.boolean(),
  errors: z.array(z.string()),
});
export type TechnicalQA = z.infer<typeof TechnicalQASchema>;

const Score = z.object({ score: z.number().int().describe("1-10"), reason: z.string() });
export const CreativeScoresSchema = z.object({
  realism: Score,
  visual_consistency: Score,
  brief_adherence: Score,
  hook_strength: Score,
  advertising_quality: Score,
  issues: z.array(z.string()).describe("Concrete visible problems, e.g. warped hands, garbled text, identity drift"),
  regeneration_notes: z
    .string()
    .describe("If quality is weak: specific prompt changes for the next attempt. Empty string otherwise."),
});
export type CreativeScores = z.infer<typeof CreativeScoresSchema>;

export function creativeRules(c: CreativeScores): string[] {
  const keys = ["realism", "visual_consistency", "brief_adherence", "hook_strength", "advertising_quality"] as const;
  return keys
    .filter((k) => !Number.isInteger(c[k].score) || c[k].score < 1 || c[k].score > 10)
    .map((k) => `${k}.score must be an integer 1-10.`);
}
