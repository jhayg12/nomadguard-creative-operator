# NomadGuard: AI Creative Operator

A small pipeline that turns a marketing brief into a finished **10–15s, 9:16 social ad**:

```
brief.json
  → Strategy        Claude: 3 angles, picks one (why / audience insight / why it works on social)
  → Storyboard      Claude: 3-5 shots, style bible, overlay text, end card
  → Prompt builder  storyboard → provider-specific request (length-checked before paying)
  → Video provider  fal.ai · Kling v3 Pro, multi-shot, native audio   (VideoProvider interface)
  → Assembly        ffmpeg: 1080x1920, burned-in captions, branded end card, audio fade
  → QA              technical (ffprobe) + creative (Claude vision on sampled frames)
  → FINALIZED / NEEDS_REVIEW / FAILED
```

**Final ad:** [`output/nomadguard-ad.mp4`](output/nomadguard-ad.mp4). The run that produced it (strategy, storyboard, prompts, QA reports, frames) is in [`output/run/`](output/run/).

## Setup

Requires Node 20+. ffmpeg/ffprobe come from npm (`ffmpeg-static`, `ffprobe-static`), so you don't need a system install.

```bash
npm install
cp .env.example .env      # ANTHROPIC_API_KEY, FAL_KEY
```

## Run

```bash
npm run demo:offline                  # whole pipeline, no API keys: canned LLM answers + mock video
npm start -- --plan-only              # strategy + storyboard only; review before paying for a render
npm run cli -- resume <jobId>         # continue a stopped/failed job from where it left off
npm start                             # full run: plan → render → assemble → QA
npm run cli -- status <jobId>         # job state, outputs, error
npm run cli -- list
npm run cli -- qa path/to/video.mp4   # technical QA on any file
npm test                              # 3 test files (see below)
```

Options: `--provider fal|mock`, `--no-creative-qa`, `--max-regens N` (default 1), `--brief other.json`.
Each job writes everything to `runs/<jobId>/`: `job.json` (state + history), `strategy.json`, `storyboard.json`,
`video_request_N.json`, `generated_N.mp4`, `final.mp4`, `qa.json`, `frames_N/`.

## Architecture

```
src/
  cli.ts                 CLI (run / resume / status / list / qa)
  schemas.ts             zod schemas + business rules the JSON schema can't express
  llm.ts                 Claude structured output + validate-and-repair retry loop
  steps/strategy.ts      Part 1
  steps/storyboard.ts    Part 2
  steps/prompts.ts       storyboard → VideoRequest (model-specific prompt style lives here only)
  steps/assemble.ts      ffmpeg edit: normalise, captions (ASS/libass), end card
  steps/qa.ts            technical + creative QA
  providers/VideoProvider.ts   generate() / getStatus() / getResult()
  providers/falKling.ts        the one real provider
  providers/mock.ts            offline provider for dry runs and tests
  job/store.ts           job.json persistence (atomic writes)
  job/runner.ts          state machine, retries, resume, regeneration loop
```

### Job lifecycle and reliability
`CREATED → PLANNING → STORYBOARDING → GENERATING → ASSEMBLING → EVALUATING → FINALIZED`
(or `NEEDS_REVIEW` / `FAILED`). Every transition is persisted with a timestamp in `job.history`.

- **Resume, not restart.** Each step skips if its output already exists. `resume` continues a `FAILED` job from the step that failed.
- **Never pay twice.** The provider request id is written to `job.json` *before* polling. A crash, timeout or outage during rendering means resume polls the same render. Submissions are capped (`maxSubmissions`).
- **Retry what's transient, fail fast on what isn't.** Errors are classified: network / 429 / 5xx are retried with exponential backoff and jitter, while validation, auth and billing errors fail immediately. Example from a real run: `Your credit balance is too low…` failed at PLANNING with the step, message and request id in `job.json`, plus a resume hint.
- **Bounded loops.** Bounded LLM repair attempts, step retries, paid submissions and creative regenerations.

### Provider abstraction
The runner only sees `VideoProvider`. A Veo/Runway/Higgsfield adapter would implement the same three methods.
A provider without multi-shot would render each `shot` separately, and assembly would concat them.
Model-specific prompt style is isolated in `steps/prompts.ts`.

### QA
- **Technical** (deterministic, `ffprobe` + a full decode pass): exists, playable, duration 10–15s, 1080x1920, 9:16, audio present. A failure here is a hard `FAILED`.
- **Creative** (Claude vision): frames at 0.3s and 1.5s (the hook window), mid-shot of each later scene, and the end card. Scores realism, visual_consistency, brief_adherence, hook_strength and advertising_quality (1–10, each with a reason), plus a list of concrete issues and prompt fixes.
  - **Gate:** pass if no score is below 6 and the average is at least 7.
  - **Below the gate:** re-plan the storyboard once with the QA findings, then re-render. If it's still below, the job ends in `NEEDS_REVIEW` (technically fine, a human decides) rather than shipping or failing silently.
  - An LLM judge is noisy: the **same render scored 6.6 and then 6.0** on two runs. So this is a cheap gate for obvious failures (identity drift, garbled text, a weak hook), not the final word. A human approves `NEEDS_REVIEW` jobs. Calibrating it is the first item in "what I would do next".
  - `npm run cli -- reassemble <jobId>` re-runs only the edit + QA on the existing footage (caption/end-card changes cost no render).

## Key decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| **Kling v3 Pro multi-shot via fal.ai** | One generation renders all shots, so the same person, wardrobe and grade carry across cuts. That is the biggest weakness of stitching separately generated clips. Native audio included. fal's queue API maps cleanly to generate/status/result. | Re-rendering one weak shot means re-rendering the whole ad. Per-shot regeneration would need a reference image + image-to-video. |
| **All text added in ffmpeg, never by the video model** | AI-rendered text/logos are garbled and kill trust; the negative prompt also bans text. | The end card is designed in code (ASS subtitles), not generated. |
| **Short, structured shot prompts with a repeated identity tag** | Kling v3 multi-shot rejects any shot prompt over **512 chars** (fal 422, learned the hard way). Storyboard rules cap shot prompts at 430 chars (fed back to the model), and a hard check refuses to submit anything over 512. | Less descriptive control per shot. |
| **Creative-QA regeneration goes back through the storyboard step** | The first version pasted QA notes straight into the video prompts. That overflowed the 512-char limit and even asked the video model for app UI text, breaking the "no generated text" rule. Now the storyboard step rewrites the shots with the QA findings, within all rules. | One extra LLM call per regeneration. |
| **Claude Opus 5.5 with structured outputs + business-rule repair loop** | The JSON schema guarantees shape; rules like "durations total 9-13s" or "hook ≤3s" are checked in code and the exact error is fed back. | Extra latency on a bad first answer (bounded at 3 attempts). |
| **`--plan-only` checkpoint** | Review the creative before spending money on a render. Product judgment: renders are the expensive step. | One more command. |
| **JSON files, not a DB or queue** | 4-hour scope; `job.json` gives inspectable state, resume and history with zero infra. | Single process, no concurrency control. In production: Postgres rows + a durable step runner (e.g. Inngest) with webhooks instead of polling. |
| **CLI, no UI** | The brief asked for a minimal interface; time went to the video and reliability. | No visual brief editor. `brief.json` is the editable brief. |

## Tests (`npm test`)
Three files, aimed at the highest-risk parts:
1. **`lifecycle.test.ts`.** The provider goes down mid-render, and the job ends `FAILED` at `GENERATING` with a readable reason and the request id saved. After `resume`, the job is `FINALIZED` with **no second paid submission**. Runs the real ffmpeg assembly + technical QA.
2. **`llm-validation.test.ts`.** A storyboard that breaks the 10–15s limit is rejected and the exact errors are fed back on retry. Malformed output gives up after N attempts with a non-retryable error, instead of being accepted.
3. **`technical-qa.test.ts`.** A 12s 1080x1920 clip passes. 16:9 and 5s clips fail with specific reasons. Missing and corrupt files are reported, not thrown.

## Intentionally not implemented
- A web UI (CLI + inspectable JSON instead).
- Music/voice-over beyond Kling's native audio; no licensed music track.
- Per-shot regeneration, multiple providers, a cost tracker, webhooks.
- A human-calibrated eval set for the creative judge.

## What I would do next (another day)
1. **Reference-image consistency:** generate one hero still of the traveler, then image-to-video per shot. That allows regenerating only the weak shot and locks identity harder.
2. **Durable execution:** move the runner to Inngest (or similar) with fal webhooks, Postgres job rows, and a small Next.js page to edit the brief, watch status and approve `NEEDS_REVIEW` jobs.
3. **Calibrate creative QA:** score ~20 renders by hand and tune the thresholds and rubric against them. Add a second judge model to reduce self-preference.
4. **Variants for testing:** render 2–3 hooks per concept (paid social is a hook-testing game), plus 1:1 / 4:5 crops.
5. **Cost and trace logging per job** (tokens, render seconds, $), e.g. to Langfuse.
