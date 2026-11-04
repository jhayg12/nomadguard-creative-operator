import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { PipelineError, backoffMs, sleep, toPipelineError } from "../errors.js";
import type { StructuredLlm } from "../llm.js";
import { log } from "../log.js";
import type { VideoProvider } from "../providers/VideoProvider.js";
import type { AudioProvider } from "../providers/AudioProvider.js";
import { END_CARD_SECONDS, type AudioPlan, type CreativeScores, type MotionSpec, type Storyboard, type Strategy } from "../schemas.js";
import { assemble } from "../steps/assemble.js";
import { buildVideoRequest } from "../steps/prompts.js";
import { creativePass, creativeQA, extractFrames, sampleTimes, technicalQA } from "../steps/qa.js";
import { buildStoryboard } from "../steps/storyboard.js";
import { planStrategy } from "../steps/strategy.js";
import { planMotion } from "../steps/motion.js";
import { renderMotion } from "../motion/render.js";
import { VO_START_SECONDS, download, durationOf, planAudio, synthesizeVoiceover } from "../steps/sound.js";
import { TERMINAL, type Job, type JobStatus, type JobStore } from "./store.js";

export interface RunnerDeps {
  store: JobStore;
  llm: StructuredLlm;
  provider: VideoProvider;
  /** Optional: without it the ad ships with the video model's native audio only. */
  audio?: AudioProvider;
  options?: Partial<RunnerOptions>;
  onUpdate?: (job: Job) => void;
}

export interface RunnerOptions {
  maxStepAttempts: number; // retries for transient errors inside one step
  maxSubmissions: number; // paid video submissions per job (incl. regenerations)
  maxRegenerations: number; // creative-QA-driven re-renders
  pollIntervalMs: number;
  generationTimeoutMs: number;
  creativeQA: boolean;
  /** code-rendered motion graphics (Remotion) instead of plain burned-in captions */
  motion: boolean;
  backoffBaseMs: number;
  /** Stop (without failing) when the job reaches this status, e.g. review the storyboard before paying for a render. */
  stopAt?: JobStatus;
}

const DEFAULTS: RunnerOptions = {
  maxStepAttempts: 3,
  maxSubmissions: 3,
  maxRegenerations: 1,
  pollIntervalMs: 10_000,
  generationTimeoutMs: 20 * 60_000,
  creativeQA: true,
  motion: true,
  backoffBaseMs: 2_000,
};

/**
 * Drives a job through its states. Every transition is persisted, every step is idempotent
 * (skips if its output already exists), so `runJob` doubles as `resume`.
 */
export async function runJob(job: Job, deps: RunnerDeps): Promise<Job> {
  const opts = { ...DEFAULTS, ...deps.options };
  const { store } = deps;

  if (job.status === "FAILED" && job.error) {
    log.info("resuming failed job", { id: job.id, from: job.error.step });
    await transition(job, job.error.step, deps, "resume");
    job.error = undefined;
  }
  if (job.status === "CREATED") await transition(job, "PLANNING", deps);

  while (!TERMINAL.includes(job.status)) {
    const step = job.status;
    if (opts.stopAt === step) {
      log.info("stopped before step (resume to continue)", { id: job.id, step });
      return job;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const next = await runStep(job, deps, opts);
        await transition(job, next, deps);
        break;
      } catch (raw) {
        const err = toPipelineError(raw, step.toLowerCase());
        log.warn("step error", { id: job.id, step, attempt, retryable: err.retryable, message: err.message });
        if (err.retryable && attempt < opts.maxStepAttempts) {
          await sleep(backoffMs(attempt, opts.backoffBaseMs));
          continue;
        }
        // Some failures are caused by an earlier step (e.g. a bad file fails QA): resume must restart there.
        const resumeStep = (err.opts.resumeFrom as JobStatus | undefined) ?? step;
        job.error = { step: resumeStep, message: err.message, retryable: err.retryable, at: new Date().toISOString(), details: err.opts.details };
        await transition(job, "FAILED", deps, err.message);
        return job;
      }
    }
  }
  await store.save(job);
  return job;
}

async function transition(job: Job, status: JobStatus, deps: RunnerDeps, note?: string) {
  job.status = status;
  job.history.push({ status, at: new Date().toISOString(), ...(note ? { note } : {}) });
  await deps.store.save(job);
  log.info("status", { id: job.id, status, ...(note ? { note } : {}) });
  deps.onUpdate?.(job);
}

async function runStep(job: Job, deps: RunnerDeps, o: RunnerOptions): Promise<JobStatus> {
  const { store, llm, provider } = deps;
  const dir = store.dir(job.id);

  switch (job.status) {
    case "PLANNING": {
      if (!job.outputs.strategy) {
        const strategy = await planStrategy(llm, job.brief);
        job.outputs.strategy = await store.writeJson(job, "strategy.json", strategy);
        await store.save(job);
      }
      return "STORYBOARDING";
    }

    case "STORYBOARDING": {
      if (!job.outputs.storyboard) {
        const strategy = await store.readJson<Strategy>(job, job.outputs.strategy!);
        const sb = await buildStoryboard(llm, job.brief, strategy, job.generation.qaNotes);
        const name = job.generation.regenerations ? `storyboard_${job.generation.regenerations + 1}.json` : "storyboard.json";
        job.outputs.storyboard = await store.writeJson(job, name, sb);
        await store.save(job);
      }
      return "GENERATING";
    }

    case "GENERATING": {
      if (job.outputs.generated) return "ASSEMBLING";
      const sb = await store.readJson<Storyboard>(job, job.outputs.storyboard!);

      if (!job.generation.requestId) {
        if (job.generation.submissions >= o.maxSubmissions)
          throw new PipelineError(`video submission budget exhausted (${o.maxSubmissions})`, { retryable: false });
        const req = buildVideoRequest(sb);
        const n = job.generation.submissions + 1;
        job.outputs.videoRequest = await store.writeJson(job, `video_request_${n}.json`, { provider: provider.name, ...req });
        const { requestId } = await provider.generate(req);
        job.generation.requestId = requestId;
        job.generation.submissions = n;
        await store.save(job); // persist before polling: never pay twice for the same render
        log.info("video submitted", { id: job.id, provider: provider.name, requestId, submission: n });
      }

      const requestId = job.generation.requestId;
      const deadline = Date.now() + o.generationTimeoutMs;
      for (;;) {
        const s = await provider.getStatus(requestId);
        if (s.state !== job.generation.lastProviderState) {
          job.generation.lastProviderState = s.state;
          await store.save(job);
          deps.onUpdate?.(job);
          log.info("provider status", { id: job.id, state: s.state, detail: s.detail });
        }
        if (s.state === "COMPLETED") break;
        if (s.state === "FAILED") {
          job.generation.requestId = undefined; // next attempt submits a fresh render
          await store.save(job);
          throw new PipelineError(`provider reported failure: ${s.detail ?? "no detail"}`, { retryable: true });
        }
        if (Date.now() > deadline)
          // Keep the request id: a later `resume` polls the same render instead of paying again.
          throw new PipelineError(`render still ${s.state} after ${o.generationTimeoutMs / 60000} min; run resume later`, { retryable: false });
        await sleep(o.pollIntervalMs);
      }

      const result = await provider.getResult(requestId);
      const file = `generated_${job.generation.submissions}.mp4`;
      await download(result.url, join(dir, file));
      job.outputs.generated = file;
      job.generation.requestId = undefined;
      await store.save(job);
      return "SCORING";
    }

    case "SCORING": {
      // Voice-over + music. Each output is skipped if it already exists, so a failed music call
      // doesn't re-bill the voice-over on resume.
      if (!deps.audio) return "ASSEMBLING";
      const sb = await store.readJson<Storyboard>(job, job.outputs.storyboard!);
      const rendered = await durationOf(join(dir, job.outputs.generated!));
      const max = job.brief.format.max_seconds;
      const total = Math.min(rendered, max - END_CARD_SECONDS - 0.1) + END_CARD_SECONDS;
      if (!job.outputs.audioPlan) {
        const plan = await planAudio(llm, job.brief, sb, total);
        job.outputs.audioPlan = await store.writeJson(job, "audio_plan.json", plan);
        await store.save(job);
      }
      const plan = await store.readJson<AudioPlan>(job, job.outputs.audioPlan);
      if (!job.outputs.voiceover) {
        await synthesizeVoiceover(deps.audio, plan, join(dir, "voiceover.mp3"), total - VO_START_SECONDS - 0.3);
        job.outputs.voiceover = "voiceover.mp3";
        await store.save(job);
      }
      if (!job.outputs.music) {
        const m = await deps.audio.music({ prompt: plan.music_prompt, durationMs: Math.ceil(total * 1000) });
        await download(m.url, join(dir, "music.mp3"));
        job.outputs.music = "music.mp3";
        await store.save(job);
      }
      return "ASSEMBLING";
    }

    case "ASSEMBLING": {
      const sb = await store.readJson<Storyboard>(job, job.outputs.storyboard!);
      const common = {
        input: join(dir, job.outputs.generated!),
        storyboard: sb,
        brief: job.brief,
        maxSeconds: job.brief.format.max_seconds,
        voiceover: job.outputs.voiceover ? join(dir, job.outputs.voiceover) : undefined,
        music: job.outputs.music ? join(dir, job.outputs.music) : undefined,
      };
      if (!o.motion) {
        await assemble({ ...common, output: join(dir, "final.mp4") });
      } else {
        // 1) base edit without text, 2) motion director writes the on-screen copy, 3) Remotion draws it.
        const base = await assemble({ ...common, output: join(dir, "base.mp4"), textOverlay: false });
        if (!job.outputs.motionSpec) {
          const audioPlan = job.outputs.audioPlan ? await store.readJson<AudioPlan>(job, job.outputs.audioPlan) : undefined;
          job.outputs.motionSpec = await store.writeJson(job, "motion_spec.json", await planMotion(llm, job.brief, sb, audioPlan));
          await store.save(job);
        }
        const spec = await store.readJson<MotionSpec>(job, job.outputs.motionSpec);
        const planned = sb.scenes.reduce((t, s) => t + s.duration, 0);
        const k = base.rendered / planned;
        let t = 0;
        const scenes = sb.scenes
          .map((s) => ({ start: (t += s.duration) - s.duration, end: t }))
          .map((s) => ({ start: s.start * k, end: Math.min(s.end * k, base.cut) }))
          .filter((s) => s.start < base.cut - 0.3);
        await renderMotion({
          base: base.output,
          output: join(dir, "final.mp4"),
          props: { brand: job.brief.brand, endHeadline: sb.end_card.headline, cta: sb.end_card.cta, spec, scenes, cut: base.cut, total: base.duration },
        });
      }
      job.outputs.final = "final.mp4";
      await store.save(job);
      return "EVALUATING";
    }

    case "EVALUATING": {
      const final = join(dir, job.outputs.final!);
      const technical = await technicalQA(final);
      let creative: (CreativeScores & { average: number; pass: boolean }) | null = null;

      if (technical.valid && o.creativeQA) {
        const sb = await store.readJson<Storyboard>(job, job.outputs.storyboard!);
        const rendered = await durationOf(join(dir, job.outputs.generated!));
        const cut = technical.duration! - END_CARD_SECONDS;
        const frames = await extractFrames(final, join(dir, `frames_${job.generation.submissions}`), sampleTimes(sb, rendered, cut, END_CARD_SECONDS));
        const scores = await creativeQA(llm, frames, sb, job.brief);
        creative = { ...scores, ...creativePass(scores) };
      }
      const report = { submission: job.generation.submissions, technical, creative, evaluatedAt: new Date().toISOString() };
      job.outputs.qa = await store.writeJson(job, `qa_${job.generation.submissions}.json`, report);
      await store.writeJson(job, "qa.json", report);
      await store.save(job);

      if (!technical.valid) {
        job.outputs.final = undefined; // the file is bad; resume re-assembles it rather than re-checking it
        throw new PipelineError(`technical QA failed: ${technical.errors.join("; ")}`, {
          retryable: false,
          details: technical,
          resumeFrom: "ASSEMBLING",
        });
      }
      if (!creative || creative.pass) return "FINALIZED";

      if (job.generation.regenerations < o.maxRegenerations) {
        // Keep this render's files; send the QA findings back through the storyboard step, which rewrites the
        // shots within all the rules (prompt limits, no generated text). Pasting raw notes into prompts broke both.
        job.generation.regenerations++;
        job.generation.qaNotes = [...creative.issues.map((i) => `- ${i}`), creative.regeneration_notes].filter(Boolean).join("\n");
        // Everything derived from the old storyboard must be regenerated too: VO script, VO, music and
        // on-screen copy were written for the old shots (bug found by a fresh end-to-end run).
        for (const k of ["storyboard", "generated", "audioPlan", "voiceover", "music", "motionSpec"] as const) job.outputs[k] = undefined;
        job.outputs.final = undefined;
        await copyFile(final, join(dir, `final_${job.generation.submissions}.mp4`));
        await store.save(job);
        log.warn("creative QA below threshold, regenerating", { id: job.id, average: creative.average, notes: job.generation.qaNotes });
        return "STORYBOARDING";
      }
      return "NEEDS_REVIEW";
    }

    default:
      throw new PipelineError(`no handler for status ${job.status}`, { retryable: false });
  }
}
