# NomadGuard: AI Creative Operator

Turns a marketing brief into a finished **10–15s, 9:16 social ad**, end to end:

```
brief.json → Strategy (Claude: 3 angles, pick one) → Storyboard (Claude: shots + prompts)
  → Video (Kling v3 Pro via fal, VideoProvider) → Sound (VO + music via fal/ElevenLabs, AudioProvider)
  → Edit (ffmpeg) → Motion graphics (Remotion) → QA (ffprobe + Claude vision) → FINALIZED / NEEDS_REVIEW / FAILED
```

**Final ad:** [`output/nomadguard-ad.mp4`](output/nomadguard-ad.mp4) (13.5s, 1080x1920, VO + music, -14 LUFS).
It was produced by a single `npm start`; every artifact of that run is in [`output/run/`](output/run/).

## The shipped run
- **Concept: "The Calm One at the Gate"**, picked from 3 angles (`output/run/strategy.json`).
  - *Why:* "everyone panics but her" tells the whole value proposition in one frame, with sound off. It needs one traveler and simple actions (look, exhale, smile, walk), which AI video renders well.
  - *Audience insight:* frequent travelers aged 25–40 have all been the panicked person at the gate and want to be the composed one, so the ad sells that identity, not a policy.
  - *Why it works on social:* the cancellation moment is instantly recognizable; the contrast format is native, meme-able and shareable; the lounge payoff carries the premium feel.
- **Pipeline path:** render 1 scored 6.2 on creative QA, which triggered an automatic re-storyboard with the QA findings and render 2 (6.4 → 6.6 after the audio fix below). It ended in `NEEDS_REVIEW` and a human approved it.
- **Bug this run exposed (fixed, with a test):** the automatic re-render reused the VO, music and on-screen copy written for the *first* storyboard. Everything derived from a storyboard is now regenerated with it. For the shipped video, the VO/music/copy were regenerated for render 2 (`run2-audio-motion-refresh.log`).
- **Known flaws:** garbled pseudo-text on the departure board and the plane's livery, and her blazer turns into a long coat in shot 3.
- **Earlier iteration:** [`output/earlier-run-2am-gate/`](output/earlier-run-2am-gate/) is the first concept ("POV: The 2 A.M. Gate"): 3 renders, the 512-char prompt limit, the duration fix, and where VO, music and the motion layer were added after review.

## Setup and run

Node 20+. ffmpeg/ffprobe ship via npm; Remotion downloads its own headless Chrome (~100 MB) on first render.

```bash
npm install
cp .env.example .env                  # ANTHROPIC_API_KEY, FAL_KEY (ElevenLabs is called through fal)
npm run demo:offline                  # whole pipeline with NO keys: canned LLM answers + mock video/audio
npm start                             # full real run: plan → render → sound → edit → motion → QA
npm start -- --plan-only              # strategy + storyboard only; review before paying for a render
npm run cli -- resume <jobId>         # continue a failed/stopped job from the failed step
npm run cli -- reassemble <jobId>     # redo sound/edit/motion/QA on existing footage (no new render)
npm run cli -- regenerate <jobId>     # reviewer-approved re-render of a NEEDS_REVIEW job
npm run cli -- status <jobId> | list | qa <file.mp4>
npm test
```

Flags: `--provider fal|mock`, `--no-motion`, `--no-creative-qa`, `--max-regens N`, `--brief other.json`.
Each job writes everything to `runs/<jobId>/` (`job.json` state + history, every intermediate file).

## How to generate a video

The interface is a CLI (Option B); there are no prompts to answer. The input is a **data file**, not source code.

1. **Edit the brief** (optional): `brief.json` holds brand, product, audience, problems, core message, brand feel and format (9:16, 10–15s). Change any text to make a different ad, or keep several briefs and pick one with `--brief my-brief.json`.
2. **Run** `npm start`. It prints the job id and one log line per step (planning → storyboard → render → sound → edit/motion → QA), and takes about 8 minutes (mostly render queue).
3. **Get the result** in `runs/<jobId>/final.mp4`, next to `strategy.json` (angles + why), `storyboard*.json`, `video_request_N.json` (exact prompts sent), `qa*.json` and `job.json` (status + history). `npm run cli -- status <jobId>` shows where a job is.

To review the creative before paying for a render: `npm start -- --plan-only`, read `strategy.json` / `storyboard.json`, then `npm run cli -- resume <jobId>`.
If the job ends in `NEEDS_REVIEW`, watch the video and either keep it or run `npm run cli -- regenerate <jobId>` for one more QA-driven render.

## Providers used

| Purpose | Provider / model | Approx. cost per run |
|---|---|---|
| Strategy, storyboard, VO script, motion copy, creative QA | Anthropic Claude Opus 5.5 | ~$0.30 |
| Video | Kling v3 Pro (multi-shot, native audio) via fal.ai | ~$2 per 12s render |
| Voice-over / music | ElevenLabs TTS multilingual v2 / ElevenLabs Music via fal.ai | cents |
| Edit, QA, motion | ffmpeg, ffprobe, Remotion (local) | free* |

\*Remotion is free for individuals and companies of up to 3 people; larger companies need a company licence.

Generative output is not deterministic: every `npm start` produces a different concept and video. Human decisions in the shipped run (which render to keep, re-editing after review) are recorded in `output/run/job.json` history.

## Architecture

```
src/cli.ts                CLI
src/schemas.ts            zod schemas + business rules JSON schema can't express (durations, prompt length, copy rules)
src/llm.ts                Claude structured output + validate-and-repair retry loop
src/steps/                strategy · storyboard · prompts · sound · assemble · motion · qa
src/providers/            VideoProvider (fal Kling, mock) · AudioProvider (fal ElevenLabs, mock)
src/motion/               Remotion composition + renderer
src/job/                  store (atomic job.json) · runner (state machine, retries, resume)
```

**Job lifecycle:** `CREATED → PLANNING → STORYBOARDING → GENERATING → SCORING → ASSEMBLING → EVALUATING → FINALIZED` (or `NEEDS_REVIEW` / `FAILED`).
- Every transition is persisted. Each step skips if its output exists, so `resume` continues from the failed step.
- The provider request id is saved **before** polling, so a crash or outage re-polls the same render and never pays twice. Paid submissions are capped.
- Network / 429 / 5xx errors retry with exponential backoff + jitter. Validation, auth and billing errors fail fast with a readable message and a resume hint.

**Provider abstraction:** the runner only sees `VideoProvider.generate/getStatus/getResult` and `AudioProvider.speech/music`. A Veo/Runway/Higgsfield adapter is one class; model-specific prompt style lives only in `steps/prompts.ts`.

**QA:**
- *Technical* (ffprobe + full decode): exists, playable, 10–15s, 1080x1920, 9:16, audio. A failure here is a hard fail that resumes from assembly.
- *Creative* (Claude vision on frames from the hook window, each shot and the end card): realism, visual consistency, brief adherence, hook strength, ad quality (1–10, each with a reason), plus concrete issues.
  - Gate: no score below 6 and an average of at least 7.
  - Below the gate: re-storyboard once with the findings and re-render. Still below → `NEEDS_REVIEW` for a human.
  - The judge is noisy (the same video scored 6.6, then 6.0), so it's a gate for obvious failures, not the final word.

## Key decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Kling v3 Pro **multi-shot** in one generation | Same person, wardrobe and grade across cuts; avoids "unrelated AI clips" | A weak shot means re-rendering the whole ad |
| **No text from the video model**; all words drawn in code | AI-generated text is garbled; negative prompt bans it | Product UI (notification card) is a graphic, not in the footage |
| Short shot prompts + repeated identity tag | Kling rejects shot prompts over 512 chars (found via a fal 422); checked before paying | Less descriptive control per shot |
| QA-driven regeneration goes **through the storyboard step** | Pasting QA notes into prompts overflowed the limit and asked for generated UI text | One extra LLM call |
| Structured outputs + business-rule repair loop | Schema guarantees shape; rules like "total 9–11s" or "no word more than twice on screen" are enforced in code and fed back | Extra latency on a bad first answer (max 3 attempts) |
| Remotion for motion graphics | Kinetic type, a product card and an animated logo are crisp and data-driven as React | ~100 MB Chrome, 30–60s render, licence for larger companies; `--no-motion` falls back to ffmpeg captions |
| VO + music with ducking, -14 LUFS | Ads are judged with sound on Reels/TikTok; the VO adds to the captions instead of repeating them | Creative QA can't hear audio |
| JSON files, not a DB/queue | 4-hour scope: inspectable, resumable, zero infra | Single process. Production: Postgres + Inngest + webhooks |
| CLI, no UI | Time went to the video and reliability | `brief.json` is the editable brief |

## Tests

1. **`lifecycle.test.ts`**: the provider goes down mid-render, the job ends `FAILED` with a readable reason and the request id saved, and `resume` finishes it with **no second paid submission**. Runs the real ffmpeg edit, audio mix and technical QA.
2. **`llm-validation.test.ts`**: a storyboard that breaks the 10–15s limit is rejected with the exact errors fed back; malformed output gives up after N attempts instead of being accepted.
3. **`technical-qa.test.ts`**: a good clip passes; 16:9, too-short, missing and corrupt files fail with specific reasons.

## Not implemented (on purpose)

Web UI · word-level caption sync to the VO · per-shot regeneration · a second video provider · cost tracking · a human-calibrated eval set for the judge · audio-aware QA.

## What I would do next

1. **Reference-image conditioning:** one hero still of the character, then image-to-video per shot, so identity locks and single shots can be re-rendered.
2. **Durable execution:** Inngest + fal webhooks + Postgres, and a small Next.js page to edit briefs and approve `NEEDS_REVIEW` jobs.
3. **Calibrate creative QA** against ~20 human-scored renders; add a second judge model.
4. **Hook variants** (2–3 per concept) and 1:1 / 4:5 crops for testing.
5. **Per-job cost and trace logging** (e.g. Langfuse).
