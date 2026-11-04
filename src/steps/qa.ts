import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg, ffprobeJson } from "../ffmpeg.js";
import { generateValidated, type ContentBlock, type StructuredLlm } from "../llm.js";
import {
  CreativeScoresSchema,
  creativeRules,
  type Brief,
  type CreativeScores,
  type Storyboard,
  type TechnicalQA,
} from "../schemas.js";

export const TARGET = { width: 1080, height: 1920, minSec: 10, maxSec: 15 };

// ---------------- Technical QA (deterministic, ffprobe) ----------------
export async function technicalQA(file: string, target = TARGET): Promise<TechnicalQA> {
  const r: TechnicalQA = {
    exists: false, playable: false, duration: null, resolution: null, aspect_ratio: null,
    has_audio: false, valid: false, errors: [],
  };
  try {
    await access(file);
    r.exists = true;
  } catch {
    r.errors.push("file does not exist");
    return r;
  }

  let probe: any;
  try {
    probe = await ffprobeJson(file);
  } catch (e: any) {
    r.errors.push(`ffprobe could not read the file: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`);
    return r;
  }
  const v = probe.streams?.find((s: any) => s.codec_type === "video");
  r.has_audio = !!probe.streams?.some((s: any) => s.codec_type === "audio");
  if (!v) {
    r.errors.push("no video stream");
    return r;
  }
  r.duration = Math.round(Number(probe.format?.duration ?? v.duration) * 100) / 100;
  r.resolution = `${v.width}x${v.height}`;
  r.aspect_ratio = ratio(v.width, v.height);

  // Playable = every frame decodes without errors (catches truncated downloads / corrupt streams).
  try {
    const { stderr } = await ffmpeg(["-v", "error", "-i", file, "-f", "null", "-"]);
    r.playable = stderr.trim().length === 0;
    if (!r.playable) r.errors.push(`decode errors: ${stderr.trim().slice(0, 200)}`);
  } catch (e: any) {
    r.errors.push(`decode failed: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`);
  }

  if (r.duration < target.minSec || r.duration > target.maxSec)
    r.errors.push(`duration ${r.duration}s is outside ${target.minSec}-${target.maxSec}s`);
  if (v.width !== target.width || v.height !== target.height)
    r.errors.push(`resolution ${r.resolution} is not ${target.width}x${target.height}`);
  if (r.aspect_ratio !== "9:16") r.errors.push(`aspect ratio ${r.aspect_ratio} is not 9:16`);
  // Missing audio is reported (has_audio) but not fatal: plenty of feed ads run silent.

  r.valid = r.errors.length === 0;
  return r;
}

function ratio(w: number, h: number) {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h);
  // Treat near-9:16 sizes (e.g. 720x1282 from a provider) as 9:16 only if within 1%.
  if (Math.abs(w / h - 9 / 16) < 0.01 && !(w / d === 9 && h / d === 16)) return `${w / d}:${h / d} (~9:16)`;
  return `${w / d}:${h / d}`;
}

// ---------------- Creative QA (vision model on sampled frames) ----------------
export const CREATIVE_THRESHOLDS = { minAny: 6, minAverage: 7 };

export function creativePass(c: CreativeScores) {
  const scores = [c.realism, c.visual_consistency, c.brief_adherence, c.hook_strength, c.advertising_quality].map((s) => s.score);
  const average = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    average: Math.round(average * 10) / 10,
    pass: Math.min(...scores) >= CREATIVE_THRESHOLDS.minAny && average >= CREATIVE_THRESHOLDS.minAverage,
  };
}

/** Frames: two inside the hook window, one mid-shot per scene, one on the end card. */
export function sampleTimes(
  sb: Storyboard,
  renderedSeconds: number,
  cutSeconds: number,
  endCardSeconds: number,
): { t: number; label: string }[] {
  const planned = sb.scenes.reduce((t, s) => t + s.duration, 0);
  const k = renderedSeconds / planned;
  const out = [{ t: 0.3, label: "hook 0.3s" }, { t: 1.5, label: "hook 1.5s" }];
  let t = 0;
  sb.scenes.forEach((s, i) => {
    const mid = Math.min((t + s.duration / 2) * k, cutSeconds - 0.3);
    if (i > 0) out.push({ t: mid, label: `scene ${i + 1} mid` });
    t += s.duration;
  });
  out.push({ t: cutSeconds + endCardSeconds * 0.85, label: "end card" });
  return out;
}

export async function extractFrames(file: string, dir: string, times: { t: number; label: string }[]) {
  await mkdir(dir, { recursive: true });
  const frames: { path: string; label: string }[] = [];
  for (const [i, s] of times.entries()) {
    const path = join(dir, `frame_${String(i).padStart(2, "0")}.jpg`);
    await ffmpeg(["-ss", s.t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=540:960", "-q:v", "3", path]);
    frames.push({ path, label: `${s.label} (t=${s.t.toFixed(1)}s)` });
  }
  return frames;
}

const SYSTEM = `You are a strict creative director reviewing a paid social video ad before it ships.
You see sampled frames in time order. Score honestly on a 1-10 scale; 7 means "good enough to run as a paid ad".
Look for: AI artifacts (warped hands/faces, melting objects, garbled text), identity drift of the main character
between shots, whether the first frames stop the scroll, whether the story and brand promise read with sound off,
and whether it feels premium and trustworthy. Be specific and brief.
Note: on-screen text, the in-app notification card, checklist and end card are motion graphics added in editing
on purpose. Judge them on design and legibility. The "no text/UI" rule applies only to the AI-generated footage
underneath (e.g. garbled signage, fake phone UI rendered by the video model).`;

export async function creativeQA(
  llm: StructuredLlm,
  frames: { path: string; label: string }[],
  sb: Storyboard,
  brief: Brief,
): Promise<CreativeScores> {
  const content: ContentBlock[] = [];
  for (const f of frames) {
    content.push({ type: "text", text: f.label });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: (await readFile(f.path)).toString("base64") },
    });
  }
  content.push({
    type: "text",
    text: `Brief core message: "${brief.core_message}". Brand feel: ${brief.brand_feel.join(", ")}.
Storyboard the video was generated from:
${JSON.stringify(sb.scenes.map((s) => ({ duration: s.duration, description: s.description, on_screen_text: s.on_screen_text })), null, 2)}
End card: ${JSON.stringify(sb.end_card)}

Score the ad. If anything should be fixed by regenerating the footage, write concrete prompt changes in regeneration_notes.`,
  });
  return generateValidated(llm, { label: "creative-qa", system: SYSTEM, schema: CreativeScoresSchema, content }, creativeRules);
}
