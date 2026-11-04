import { generateValidated, type StructuredLlm } from "../llm.js";
import { MotionSpecSchema, motionRules, type AudioPlan, type Brief, type MotionSpec, type Storyboard } from "../schemas.js";

const SYSTEM = `You are a motion designer writing the on-screen copy for kinetic typography in a 9:16 paid social ad.
The graphics are rendered in code over the footage: a hook stamp, an in-app notification card, two kinetic
lines, a 3-item checklist. Copy must be punchy, scannable in under a second, and consistent with the brief.
Never invent facts the brief doesn't state (no prices, percentages, timings or guarantees).
The checklist must name CONCRETE benefits tied to the brief's problems (disruption handled, rebooking, a place
to stay, costs covered), never vague feelings like "calm restored". The card title must not repeat the brand:
the card already shows the brand as the app name.`;

export function planMotion(llm: StructuredLlm, brief: Brief, sb: Storyboard, audio?: AudioPlan): Promise<MotionSpec> {
  return generateValidated(
    llm,
    {
      label: "motion-spec",
      system: SYSTEM,
      schema: MotionSpecSchema,
      content: `Brand: ${brief.brand}. Core message: "${brief.core_message}". Feel: ${brief.brand_feel.join(", ")}.
Shots: ${sb.scenes.map((s, i) => `\n${i + 1}. ${s.description} | caption: "${s.on_screen_text}"`).join("")}
Template mapping: shot 1 = hook (kicker + stamp + headline), shot 2 = notification card from ${brief.brand},
shot 3 = kinetic lines, shot 4 = checklist. End card (already written): ${sb.end_card.headline} / ${sb.end_card.cta}.${
        audio ? `\nVoice-over (don't just repeat it): "${audio.voiceover}"` : ""
      }`,
    },
    (m) => motionRules(m, brief.brand, [sb.end_card.headline, sb.end_card.cta]),
  );
}
