import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, ffprobeJson } from "../ffmpeg.js";
import { END_CARD_SECONDS, type Brief, type Storyboard } from "../schemas.js";
import { PipelineError } from "../errors.js";
import { VO_START_SECONDS } from "./sound.js";

const FONTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");
const W = 1080, H = 1920;

/**
 * Editing pass with ffmpeg:
 *  - normalise to 1080x1920 @30fps (crop-to-fill, never letterbox), trim footage so the ad fits the max length
 *  - animated captions: words pop in one by one (TikTok style), key words in the brand accent colour
 *  - freeze the last frame, blur + dim it, animate the end card (brand rises in, accent rule grows, CTA pops)
 *  - audio: native ambience (low) + music bed ducked under the voice-over (sidechain) + VO, normalised to -14 LUFS
 * Text is added here, not by the video model, because generated text is unreliable.
 */
export async function assemble(opts: {
  input: string;
  output: string;
  storyboard: Storyboard;
  brief: Brief;
  maxSeconds: number;
  voiceover?: string;
  music?: string;
  /** false = no burned-in text (the Remotion motion layer draws all text instead) */
  textOverlay?: boolean;
}): Promise<{ output: string; duration: number; rendered: number; cut: number }> {
  const probe = await ffprobeJson(opts.input);
  const v = probe.streams.find((s: any) => s.codec_type === "video");
  if (!v) throw new PipelineError("generated file has no video stream", { retryable: true });
  const hasAudio = probe.streams.some((s: any) => s.codec_type === "audio");
  // Providers overshoot requested lengths slightly; cut the tail so footage + end card always fits the max.
  const rendered = Number(probe.format.duration);
  const D = Math.min(rendered, opts.maxSeconds - END_CARD_SECONDS - 0.1);
  const total = D + END_CARD_SECONDS;

  const assPath = join(dirname(opts.output), "overlay.ass");
  await writeFile(assPath, buildAss(opts.storyboard, opts.brief, rendered, D));

  const at = D.toFixed(3);
  const vf =
    `[0:v]trim=0:${at},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,` +
    `tpad=stop_mode=clone:stop_duration=${END_CARD_SECONDS},` +
    `boxblur=luma_radius=20:luma_power=2:enable='gte(t,${at})',` +
    `eq=brightness=-0.08:contrast=0.85:saturation=0.9:enable='gte(t,${at})',` +
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.28:t=fill:enable='gte(t,${at})'` +
    (opts.textOverlay === false ? `[v]` : `,subtitles=filename='${esc(assPath)}':fontsdir='${esc(FONTS_DIR)}'[v]`);

  const T = total.toFixed(3);
  const inputs = ["-i", opts.input];
  const parts: string[] = [];
  const mixIn: string[] = [];
  // Native Kling ambience stays underneath as texture.
  parts.push(
    hasAudio
      ? `[0:a]atrim=0:${at},asetpts=PTS-STARTPTS,apad=pad_dur=${END_CARD_SECONDS},atrim=0:${T},volume=${opts.voiceover ? 0.3 : 1}[amb]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${T}[amb]`,
  );
  mixIn.push("[amb]");
  let idx = 1;
  let voKey: string | null = null;
  if (opts.voiceover) {
    inputs.push("-i", opts.voiceover);
    const ms = Math.round(VO_START_SECONDS * 1000);
    parts.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}:all=1,apad,atrim=0:${T},volume=1.15,asplit=2[vo][vokey]`);
    voKey = "[vokey]";
    idx++;
  }
  if (opts.music) {
    inputs.push("-i", opts.music);
    parts.push(
      `[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${T},volume=0.55,` +
        `afade=t=in:d=0.4,afade=t=out:st=${(total - 1.4).toFixed(3)}:d=1.4[mus0]`,
    );
    // Duck the music whenever the voice speaks, so the VO stays intelligible on phone speakers.
    parts.push(voKey ? `[mus0]${voKey}sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[mus]` : `[mus0]anull[mus]`);
    mixIn.push("[mus]");
    idx++;
  } else if (voKey) {
    parts.push(`${voKey}anullsink`);
  }
  if (opts.voiceover) mixIn.push("[vo]");
  parts.push(
    `${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=first,` +
      `afade=t=out:st=${(total - 0.6).toFixed(3)}:d=0.6,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`, // social platforms normalise to about -14 LUFS
  );

  await ffmpeg([
    ...inputs,
    "-filter_complex", `${vf};${parts.join(";")}`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    "-t", T,
    opts.output,
  ]).catch((err) => {
    throw new PipelineError(`ffmpeg assembly failed: ${String(err.stderr ?? err.message).slice(-600)}`, { retryable: false });
  });
  return { output: opts.output, duration: total, rendered, cut: D };
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

function clean(t: string) {
  return t.replace(/[{}\\]/g, "").trim();
}

// ASS colours are &HAABBGGRR. Accent = soft teal #5EEAD4.
const ACCENT = "&H00D4EA5E&";
const KEY_WORDS = /^(covered|sorted|protected|confidence|covered\.|sorted\.)/i;

/**
 * One caption, words popping in one after another: each word starts invisible and 80% size,
 * then fades + scales to 100% (libass \t animation). Key words get the accent colour.
 */
export function popWords(text: string, perWordMs = 110): string {
  return clean(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const t0 = i * perWordMs;
      const colour = KEY_WORDS.test(w) ? `\\1c${ACCENT}` : "";
      return `{\\alpha&HFF&\\fscx80\\fscy80${colour}\\t(${t0},${t0 + 160},\\alpha&H00&\\fscx100\\fscy100)}${w}`;
    })
    .join(" ");
}

/**
 * ASS script. `renderedSeconds` is the provider's real length (used to map storyboard times onto the footage);
 * `cutSeconds` is where the footage is cut for the end card (captions past the cut are clipped, not squeezed).
 */
export function buildAss(sb: Storyboard, brief: Brief, renderedSeconds: number, cutSeconds = renderedSeconds): string {
  const planned = sb.scenes.reduce((t, s) => t + s.duration, 0);
  const k = planned > 0 ? renderedSeconds / planned : 1;
  const lines: string[] = [];
  let t = 0;
  for (const s of sb.scenes) {
    const start = t * k, end = Math.min((t + s.duration) * k, cutSeconds);
    t += s.duration;
    if (!s.on_screen_text.trim() || start >= cutSeconds - 0.5) continue;
    lines.push(`Dialogue: 0,${ts(start + 0.15)},${ts(end - 0.12)},Caption,,0,0,0,,{\\fad(0,180)}${popWords(s.on_screen_text)}`);
  }

  const e0 = cutSeconds, e1 = cutSeconds + END_CARD_SECONDS + 0.1;
  // Brand rises 40px while fading in; accent rule grows from the centre; headline fades; CTA pops last.
  lines.push(`Dialogue: 2,${ts(e0 + 0.15)},${ts(e1)},Brand,,0,0,0,,{\\an5\\move(540,850,540,810,0,450)\\fad(350,0)\\fscx92\\fscy92\\t(0,450,\\fscx100\\fscy100)}${clean(brief.brand)}`);
  lines.push(`Dialogue: 2,${ts(e0 + 0.45)},${ts(e1)},Rule,,0,0,0,,{\\an5\\pos(540,890)\\fscx0\\t(0,400,\\fscx100)\\p1}m 0 0 l 180 0 l 180 6 l 0 6{\\p0}`);
  lines.push(`Dialogue: 2,${ts(e0 + 0.7)},${ts(e1)},Tagline,,0,0,0,,{\\an8\\pos(540,930)\\fad(400,0)}${clean(sb.end_card.headline)}`);
  lines.push(`Dialogue: 2,${ts(e0 + 1.25)},${ts(e1)},CTA,,0,0,0,,{\\an5\\pos(540,1170)\\alpha&HFF&\\fscx70\\fscy70\\t(0,180,\\alpha&H00&\\fscx108\\fscy108)\\t(180,320,\\fscx100\\fscy100)}${clean(sb.end_card.cta)}`);

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Montserrat ExtraBold,82,&H00FFFFFF,&H00FFFFFF,&H90000000,&H64000000,0,0,0,0,100,100,0,0,1,3,4,2,80,80,560,1
Style: Brand,Montserrat ExtraBold,128,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,2,0,1,0,3,5,60,60,0,1
Style: Rule,Montserrat,10,${ACCENT},${ACCENT},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: Tagline,Montserrat,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,0,2,8,120,120,0,1
Style: CTA,Montserrat ExtraBold,52,&H004A2A12,&H004A2A12,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,1,0,3,28,0,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
}
