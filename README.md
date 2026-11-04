# NomadGuard: AI Creative Operator

A small pipeline that turns a marketing brief into a finished **10–15s, 9:16 social ad**:

```
brief.json
  → Strategy        Claude: 3 angles, picks one (why / audience insight / why it works on social)
  → Storyboard      Claude: 3-5 shots, style bible, overlay text, end card
  → Prompt builder  storyboard → provider-specific request (length-checked before paying)
  → Video provider  fal.ai · Kling v3 Pro, multi-shot, native audio   (VideoProvider interface)
  → Sound design    Claude writes VO script + music brief; ElevenLabs TTS + ElevenLabs Music via fal (AudioProvider)
  → Assembly        ffmpeg base edit: 1080x1920, end-card plate, ambience + ducked music + VO, -14 LUFS
  → Motion layer    Claude "motion director" writes a MotionSpec; Remotion (React → video) renders kinetic
                    type, an in-app notification card, checklist and an animated logo end card over the base
  → QA              technical (ffprobe) + creative (Claude vision on sampled frames)
  → FINALIZED / NEEDS_REVIEW / FAILED
```

**Final ad:** [`output/nomadguard-ad.mp4`](output/nomadguard-ad.mp4) (14.9s, 1080x1920, H.264 + AAC, voice-over + music, -14 LUFS).
The run that produced it (strategy, storyboards, provider requests, QA reports, logs, contact sheets) is in [`output/run/`](output/run/).

## Results of the real run
Concept selected by the planner: **"POV: The 2 A.M. Gate"**. A traveler stranded at a night gate gets it sorted from her phone in minutes, walks off calm, and wakes up to sunrise in a hotel. End card: *NomadGuard · Because delays happen. Be covered when they do. · Get covered in 2 minutes*.

| Render | What changed | Technical QA | Creative QA (avg) | Main findings |
|---|---|---|---|---|
| 1 | first storyboard | ✅ 14.04s | 6.2 | hair/wardrobe drift between shots, hook doesn't show the airport, captions low-contrast |
| 2 | storyboard rewritten from render-1 QA | ❌ 15.04s → fixed in assembly → ✅ 14.9s | 6.6, re-scored 6.0 after re-edit | identity now consistent (visual consistency 6→8); garbled departure-board text, blank phone screen |
| 3 | reviewer-approved regenerate from render-2 QA | ✅ 13.04s | 5.8 | **identity drift** in the final shot, a different-looking woman |

After review, the shipped edit adds voice-over, music, a Remotion motion-graphics layer and a longer end card on top of render 2. With the motion layer, creative QA passed the gate once (7.2) and then scored 6.6 and 6.8 on near-identical re-renders: more evidence that the judge is a ±0.5 noisy gate ([contact sheet](output/run/contact-sheets/final.jpg)). That was a re-edit, not a re-render.

**Shipped: render 2** ([contact sheet](output/run/contact-sheets/render_2.jpg)). The pipeline ended in `NEEDS_REVIEW` (no render cleared the 7.0 gate), and choosing the best of N is exactly the human decision that state exists for. Render 2 has the most consistent protagonist and the most premium look; its known flaws (slightly garbled text on the out-of-focus departure board, a plain phone screen) are minor at phone size. Render 3 shows that "more QA-driven retries" is not monotonic improvement: fixing one finding introduced worse identity drift. That's the strongest argument for reference-image conditioning (see below). The 3-submission cap stopped further spend.

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
npm run cli -- reassemble <jobId>     # redo only the edit + QA on existing footage (free)
npm run cli -- regenerate <jobId>     # reviewer-approved re-render of a NEEDS_REVIEW job, driven by its QA findings
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
  cli.ts                 CLI (run / resume / reassemble / regenerate / status / list / qa)
  schemas.ts             zod schemas + business rules the JSON schema can't express
  llm.ts                 Claude structured output + validate-and-repair retry loop
  steps/strategy.ts      Part 1
  steps/storyboard.ts    Part 2
  steps/prompts.ts       storyboard → VideoRequest (model-specific prompt style lives here only)
  steps/sound.ts         voice-over script + music brief (Claude), TTS length check
  steps/assemble.ts      ffmpeg edit: normalise, end-card plate, audio mix (+ ASS captions fallback: --no-motion)
  steps/motion.ts        motion director: on-screen copy as a validated MotionSpec
  motion/Ad.tsx          Remotion composition: hook, notification card, kinetic lines, checklist, end card
  motion/render.ts       bundle + render with headless Chrome, then mux the mixed audio back in
  steps/qa.ts            technical + creative QA
  providers/VideoProvider.ts   generate() / getStatus() / getResult()
  providers/falKling.ts        the one real provider
  providers/mock.ts            offline provider for dry runs and tests
  providers/AudioProvider.ts   speech() / music()
  providers/falElevenLabs.ts   ElevenLabs TTS (multilingual v2) + ElevenLabs Music via fal
  providers/mockAudio.ts       offline tones for tests
  job/store.ts           job.json persistence (atomic writes)
  job/runner.ts          state machine, retries, resume, regeneration loop
```

### Job lifecycle and reliability
`CREATED → PLANNING → STORYBOARDING → GENERATING → SCORING → ASSEMBLING → EVALUATING → FINALIZED`
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

### Motion graphics (Remotion)
All readable graphics are drawn in code, never by the video model, so they're crisp and say exactly what was approved:
- **Hook (0–3s):** "2:00 AM" clock drops in, a red stamp slams in with overshoot and a camera shake, then a huge headline rises letter by letter. All of it lands by 0.3–0.5s.
- **Product moment:** an in-app NomadGuard notification slides in, its shield check draws on, and a status pill pops. This fixes QA's repeated complaint that the product was invisible.
- **Kinetic lines** slide in word by word, with a teal highlight bar sweeping behind the key word (auto-fit to one line each).
- **Checklist** of three concrete benefits ticks in, in the lower third so the face stays clear.
- **End card:** the shield logo draws itself, the brand rises in, an accent rule grows, the headline fades in, and the CTA pops with a light sweep.
- **Camera:** slow push-in per shot, a punch-in plus a white flash on every cut.
- The copy comes from a **motion director** LLM step (`motion_spec.json`) with rules: word limits, no invented numbers, the card title must not repeat the brand, and no content word more than twice across all on-screen copy. That last rule caught "covered" used 7 times on its first try.
- `--no-motion` falls back to the ffmpeg/ASS animated captions.

### Sound design
- **Voice-over:** Claude writes a script that adds to the captions rather than repeating them. It's checked for length (≤ 2.5 words/s with 1s of air) and must say the brand. ElevenLabs reads it, and the clip's duration is checked: if it runs long it's re-read once at 1.12x, otherwise the step fails rather than cutting words.
- **Music:** an instrumental ElevenLabs Music bed, generated to the exact ad length from Claude's brief (tension → relief → warm resolve).
- **Mix:** Kling's native ambience at 30%, music side-chain-ducked under the voice, then loudness-normalised to -14 LUFS (what Reels/TikTok target).
- **End card** holds for **3.5s** so it can be read; footage is trimmed to make room inside 15s.
- Every output is cached (`audio_plan.json`, `voiceover.mp3`, `music.mp3`), so `reassemble` re-edits without paying for audio again.

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
- Word-level caption sync to the voice-over (ElevenLabs can return timestamps; captions are per shot today).
- Creative QA only sees frames; it does not listen to the audio mix.
- Per-shot regeneration, multiple providers, a cost tracker, webhooks.
- A human-calibrated eval set for the creative judge.

## What I would do next (another day)
1. **Reference-image consistency:** generate one hero still of the traveler, then image-to-video per shot. That allows regenerating only the weak shot and locks identity harder.
2. **Durable execution:** move the runner to Inngest (or similar) with fal webhooks, Postgres job rows, and a small Next.js page to edit the brief, watch status and approve `NEEDS_REVIEW` jobs.
3. **Calibrate creative QA:** score ~20 renders by hand and tune the thresholds and rubric against them. Add a second judge model to reduce self-preference.
4. **Variants for testing:** render 2–3 hooks per concept (paid social is a hook-testing game), plus 1:1 / 4:5 crops.
5. **Cost and trace logging per job** (tokens, render seconds, $), e.g. to Langfuse.
