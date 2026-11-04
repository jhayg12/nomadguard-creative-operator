import type { z } from "zod";
import type { LlmRequest, StructuredLlm } from "../src/llm.js";
import type { Brief, CreativeScores, Storyboard, Strategy } from "../src/schemas.js";

export const brief: Brief = {
  brand: "NomadGuard",
  product: "Travel protection",
  audience: "Frequent travelers 25-40",
  problem: ["uncertainty", "stress", "unexpected financial loss"],
  core_message: "Travel with confidence knowing that you are protected when things go wrong.",
  brand_feel: ["modern", "premium"],
  format: { platforms: ["TikTok"], aspect_ratio: "9:16", min_seconds: 10, max_seconds: 15 },
};

export const strategy: Strategy = {
  angles: ["A", "B", "C"].map((n) => ({ name: n, target_emotion: "relief", hook: "h", concept: "c", cta: "cta" })),
  selected_index: 0,
  selection: { why_selected: "w", audience_insight: "i", why_it_works_on_social: "s" },
};

const scene = (duration: number, text = "") => ({ duration, description: "d", camera: "c", on_screen_text: text, video_prompt: "p" });
export const storyboard: Storyboard = {
  title: "t",
  style_bible: { character: "c", wardrobe: "w", setting: "s", color_grade: "g", lens_and_light: "l" },
  scenes: [scene(3, "Flight cancelled?"), scene(3), scene(2, "Covered."), scene(3)],
  end_card: { headline: "Travel with confidence", cta: "Get covered" },
  sound: "airport ambience",
};

const s = (score: number) => ({ score, reason: "r" });
export const goodScores: CreativeScores = {
  realism: s(8), visual_consistency: s(8), brief_adherence: s(8), hook_strength: s(8), advertising_quality: s(8),
  issues: [], regeneration_notes: "",
};

/** Returns canned answers per label; records every request so tests can inspect prompts. */
export class StubLlm implements StructuredLlm {
  calls: LlmRequest<z.ZodType>[] = [];
  constructor(private answers: Record<string, unknown[]>) {}
  async complete<S extends z.ZodType>(req: LlmRequest<S>) {
    this.calls.push(req as unknown as LlmRequest<z.ZodType>);
    const queue = this.answers[req.label];
    if (!queue?.length) throw new Error(`StubLlm: no answer left for ${req.label}`);
    return queue.length > 1 ? queue.shift() : queue[0];
  }
}

export const audioPlan = {
  voiceover: "Stranded at two a.m.? Not anymore. NomadGuard sorts it, so you can travel with confidence.",
  voice_direction: "warm, calm",
  music_prompt: "minimal warm piano and soft synth, builds gently",
};

export const motionSpec = {
  hook: { kicker: "2:00 AM", stamp: "CANCELLED", headline: "STRANDED." },
  product_card: { title: "Hotel booked", body: "Rebooked on the first flight out.", badge: "Covered" },
  kinetic: { line1: "Delays happen.", line2: "You're covered.", highlight: "covered." },
  checklist: ["Rebooked", "Hotel covered", "Costs covered"],
};

export const happyLlm = () =>
  new StubLlm({
    strategy: [strategy],
    storyboard: [storyboard],
    "audio-plan": [audioPlan],
    "motion-spec": [motionSpec],
    "creative-qa": [goodScores],
  });
