import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { ffmpeg } from "../ffmpeg.js";
import { PipelineError } from "../errors.js";
import type { AdProps } from "./Ad.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONTS = resolve(HERE, "../../assets/fonts");

/**
 * Renders the code-driven motion layer (Remotion / headless Chrome) over the edited base video,
 * then muxes the already-mixed audio from the base back in (stream copy, no re-encode of audio).
 */
export async function renderMotion(opts: { base: string; output: string; props: AdProps }) {
  const pub = join(dirname(opts.output), "motion_public");
  await mkdir(join(pub, "fonts"), { recursive: true });
  await copyFile(opts.base, join(pub, "base.mp4"));
  for (const w of ["500", "700", "800"]) await copyFile(join(FONTS, `Montserrat-${w}.ttf`), join(pub, "fonts", `Montserrat-${w}.ttf`));

  const silent = join(dirname(opts.output), "motion_silent.mp4");
  try {
    const serveUrl = await bundle({
      entryPoint: join(HERE, "index.ts"),
      publicDir: pub,
      // NodeNext-style ".js" imports point at .ts/.tsx sources; teach webpack the same mapping.
      webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, extensionAlias: { ".js": [".tsx", ".ts", ".js"] } } }),
    });
    const composition = await selectComposition({ serveUrl, id: "Ad", inputProps: opts.props });
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      crf: 18,
      pixelFormat: "yuv420p",
      muted: true,
      outputLocation: silent,
      inputProps: opts.props,
      concurrency: 4,
      chromiumOptions: { gl: "swangle" },
    });
  } catch (err: any) {
    throw new PipelineError(`motion render failed: ${err?.message ?? err}`, { retryable: false, resumeFrom: "ASSEMBLING" });
  }
  await ffmpeg([
    "-i", silent, "-i", opts.base,
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart",
    opts.output,
  ]);
}
