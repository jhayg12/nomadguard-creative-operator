import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, ffprobeJson } from "../ffmpeg.js";
import { END_CARD_SECONDS, type Brief, type Storyboard } from "../schemas.js";
import { PipelineError } from "../errors.js";

const FONTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");
const W = 1080, H = 1920;

/**
 * Editing pass with ffmpeg:
 *  - normalise to 1080x1920 @30fps (crop-to-fill, never letterbox)
 *  - burn in the per-shot overlay text (kept inside the TikTok/Reels safe zone)
 *  - freeze the last frame, blur + darken it, and lay the branded end card + CTA on top
 *  - pad/fade the native audio under the end card
 * Text is added here, not by the video model, because generated text is unreliable.
 */
export async function assemble(opts: {
  input: string;
  output: string;
  storyboard: Storyboard;
  brief: Brief;
  maxSeconds: number;
}): Promise<{ output: string; duration: number }> {
  const probe = await ffprobeJson(opts.input);
  const v = probe.streams.find((s: any) => s.codec_type === "video");
  if (!v) throw new PipelineError("generated file has no video stream", { retryable: true });
  const hasAudio = probe.streams.some((s: any) => s.codec_type === "audio");
  // Providers overshoot requested lengths slightly; trim footage so footage + end card always fits the max.
  const rendered = Number(probe.format.duration);
  const D = Math.min(rendered, opts.maxSeconds - END_CARD_SECONDS - 0.1);

  const assPath = join(dirname(opts.output), "overlay.ass");
  await writeFile(assPath, buildAss(opts.storyboard, opts.brief, D));

  const vf =
    `[0:v]trim=0:${D.toFixed(3)},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,` +
    `tpad=stop_mode=clone:stop_duration=${END_CARD_SECONDS},` +
    `boxblur=luma_radius=20:luma_power=2:enable='gte(t,${D.toFixed(3)})',` +
    `eq=brightness=-0.08:contrast=0.85:saturation=0.9:enable='gte(t,${D.toFixed(3)})',` +
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.28:t=fill:enable='gte(t,${D.toFixed(3)})',` +
    `subtitles=filename='${esc(assPath)}':fontsdir='${esc(FONTS_DIR)}'[v]`;
  const total = D + END_CARD_SECONDS;
  const af = hasAudio
    ? `[0:a]atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${END_CARD_SECONDS},atrim=0:${total.toFixed(3)},afade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[a]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)}[a]`;

  await ffmpeg([
    "-i", opts.input,
    "-filter_complex", `${vf};${af}`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-t", total.toFixed(3),
    opts.output,
  ]).catch((err) => {
    throw new PipelineError(`ffmpeg assembly failed: ${String(err.stderr ?? err.message).slice(-600)}`, { retryable: false });
  });
  return { output: opts.output, duration: total };
}

/** Escape a path for use inside an ffmpeg filtergraph option value. */
function esc(p: string) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function ts(sec: number) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
}

function assText(t: string) {
  return t.replace(/[{}]/g, "").replace(/\n/g, "\\N");
}

/** ASS subtitle script: overlay captions per shot + end card. Times are scaled to the real render length. */
export function buildAss(sb: Storyboard, brief: Brief, renderedSeconds: number): string {
  const planned = sb.scenes.reduce((t, s) => t + s.duration, 0);
  const k = planned > 0 ? renderedSeconds / planned : 1;
  const lines: string[] = [];
  let t = 0;
  for (const s of sb.scenes) {
    const start = t * k, end = (t + s.duration) * k;
    t += s.duration;
    if (!s.on_screen_text.trim()) continue;
    lines.push(`Dialogue: 0,${ts(start + 0.15)},${ts(end - 0.1)},Caption,,0,0,0,,{\\fad(180,150)}${assText(s.on_screen_text)}`);
  }
  const e0 = renderedSeconds, e1 = renderedSeconds + END_CARD_SECONDS + 0.1;
  lines.push(`Dialogue: 1,${ts(e0 + 0.1)},${ts(e1)},Brand,,0,0,0,,{\\fad(250,0)\\pos(540,820)}${assText(brief.brand)}`);
  lines.push(`Dialogue: 1,${ts(e0 + 0.35)},${ts(e1)},Tagline,,0,0,0,,{\\fad(250,0)\\pos(540,975)}${assText(sb.end_card.headline)}`);
  lines.push(`Dialogue: 1,${ts(e0 + 0.6)},${ts(e1)},CTA,,0,0,0,,{\\fad(250,0)\\pos(540,1150)}${assText(sb.end_card.cta)}`);

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Montserrat ExtraBold,78,&H00FFFFFF,&H00FFFFFF,&H90000000,&H64000000,0,0,0,0,100,100,0,0,1,2.5,4,2,80,80,560,1
Style: Brand,Montserrat ExtraBold,124,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,2,0,1,0,2,5,60,60,0,1
Style: Tagline,Montserrat,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,0,2,5,100,100,0,1
Style: CTA,Montserrat ExtraBold,50,&H004A2A12,&H004A2A12,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,1,0,3,26,0,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
}
