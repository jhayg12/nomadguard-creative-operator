# AI usage

## Tools
- **Claude Code (Claude Opus 5.5)** in the terminal: the main coding agent. I used it to plan the build, scaffold the project, write most of the code, tests and docs, and run the pipeline and inspect outputs (logs, rendered frames, ffprobe).
- **Claude (API, Opus 5.5)** inside the product: strategy, storyboard and creative QA. That's part of the system, not a dev tool.
- **fal.ai / Kling v3 Pro**: video generation.

## What was AI-generated
Most of the code (~90%) was written by Claude Code from my direction and then reviewed. Decisions that were mine: the provider choice (fal + Kling), the `--plan-only` checkpoint before paid renders, keeping all text in ffmpeg, JSON-file state instead of a DB for this timebox, and which three things to test. I reviewed every file, ran everything locally, and checked outputs by eye (frames and the final video), not only through tests.

## AI decision I changed / rejected
**Prompt construction.** The first prompt builder followed a common pattern: paste the full style bible (character, wardrobe, setting, colour grade, lens) plus a long realism suffix into every shot prompt "for consistency". On the first real storyboard that produced ~2,500-character prompts per shot. Kling's multi-shot prompts are much shorter, so a paid render would likely have been truncated or rejected. I rejected that design:
- the storyboard prompt now asks for compact shot prompts (≤400 chars) that open with the same short identity tag
- `storyboardRules` enforces the limit and feeds violations back to the model
- `buildVideoRequest` has a hard length check that refuses to submit before any money is spent

## Problems introduced by AI that I caught
1. **Colour grade applied to the wrong shots.** After shortening the prompts, the builder still appended the style bible's first colour-grade sentence to every shot. The storyboard's grade described the whole arc ("cool night that flips to warm golden morning"), so the 2 a.m. airport shots were being told to be golden morning. I caught it reading the final prompts before submitting, and removed the global grade so each shot carries its own lighting (commented in `steps/prompts.ts`).
2. **Font silently fell back.** The first assembly used Montserrat as a variable font. libass loaded the file but couldn't match the Bold weight from a variable font and silently used DejaVu Sans Bold. The render "worked", so nothing failed. I spotted the wrong typeface on the extracted frame, confirmed it with ffmpeg's debug log (`fontselect: (Montserrat, 700) -> DejaVuSans-Bold`), and replaced it with static Montserrat weights.
3. **Regeneration loop broke the prompt contract.** The AI-written regeneration path appended the creative-QA notes to every shot prompt. On the first real run, creative QA scored the render 6.2/10 (with fair findings: wardrobe/hair drift, no airport context in the hook). The automatic re-render then failed with a fal 422, and our error message only said "Unprocessable Entity". I pulled the body from the fal queue API: `Prompt must not exceed 512 characters`. The notes had also asked for an app screen with text, which contradicts the rule that the video model never renders text. Fixes:
   - re-renders now go back through the storyboard step with the QA findings, so the rules and limits still apply
   - 512 is enforced before submitting
   - provider error bodies are kept in the job error

## How I supervised it
- Read the generated strategy, storyboard and final prompts before allowing a paid render (`--plan-only`).
- Checked rendered frames visually, not just exit codes.
- Kept tests focused on the riskiest behaviour: paying twice, accepting invalid LLM output, shipping a technically broken file.
