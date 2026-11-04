import type { Brief, Strategy } from "../schemas.js";
import { StrategySchema, strategyRules } from "../schemas.js";
import { generateValidated, type StructuredLlm } from "../llm.js";

const SYSTEM = `You are a senior performance-creative strategist for paid social (Instagram Reels, TikTok).
You write angles that can be shot as a 10-15 second photorealistic AI-generated video.

Constraints that matter for AI video:
- One recurring traveler, simple readable actions, few locations. No crowds doing complex choreography.
- The story must read with the sound OFF: the problem and the relief must be visible on faces and objects.
- Never rely on the video model to render readable text, logos, UI or numbers. Text is added in editing.
- The first 2-3 seconds must stop the scroll: open on the moment of disruption or a striking visual, never on a logo or a slow establishing shot.

Be decisive and brief. Good creative judgment beats long explanations.`;

export async function planStrategy(llm: StructuredLlm, brief: Brief): Promise<Strategy> {
  return generateValidated(
    llm,
    {
      label: "strategy",
      system: SYSTEM,
      schema: StrategySchema,
      content: `Marketing brief (JSON):
${JSON.stringify(brief, null, 2)}

Produce exactly 3 clearly different creative angles (different emotions and story mechanics, not three versions of one idea).
Then pick the one most likely to perform as a paid social ad AND most likely to render well with today's AI video models.
Set selected_index to its 0-based position. Keep each field to 1-2 sentences.`,
    },
    strategyRules,
  );
}
