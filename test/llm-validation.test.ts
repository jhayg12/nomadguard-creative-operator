import { describe, expect, it } from "vitest";
import { generateValidated } from "../src/llm.js";
import { StoryboardSchema, storyboardRules } from "../src/schemas.js";
import { buildStoryboard } from "../src/steps/storyboard.js";
import { brief, storyboard, strategy, StubLlm } from "./fixtures.js";

process.env.QUIET = "1";

describe("LLM output validation", () => {
  it("rejects a storyboard that would break the 10-15s limit and feeds the exact error back on retry", async () => {
    const tooLong = { ...storyboard, scenes: storyboard.scenes.map((s) => ({ ...s, duration: 5 })) }; // 20s
    const llm = new StubLlm({ storyboard: [tooLong, storyboard] });

    const result = await buildStoryboard(llm, brief, strategy);

    expect(result.scenes.reduce((t, s) => t + s.duration, 0)).toBe(11);
    expect(llm.calls).toHaveLength(2);
    const retryPrompt = llm.calls[1].content as string;
    expect(retryPrompt).toMatch(/add up to 20s/);
    expect(retryPrompt).toMatch(/Scene 1 is the hook/);
  });

  it("gives up with a non-retryable error instead of accepting invalid output forever", async () => {
    const malformed = { title: "x", scenes: "not an array" };
    const llm = new StubLlm({ storyboard: [malformed] });
    await expect(
      generateValidated(llm, { label: "storyboard", system: "", content: "", schema: StoryboardSchema }, storyboardRules, 3),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/failed validation after 3 attempts/) });
    expect(llm.calls).toHaveLength(3);
  });
});
