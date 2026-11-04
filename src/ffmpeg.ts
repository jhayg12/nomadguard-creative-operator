import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const run = promisify(execFile);

/** Bundled binaries so reviewers don't need a system ffmpeg. Override with FFMPEG_PATH / FFPROBE_PATH. */
export const FFMPEG = process.env.FFMPEG_PATH ?? (ffmpegPath as unknown as string);
export const FFPROBE = process.env.FFPROBE_PATH ?? ffprobeStatic.path;

export async function ffmpeg(args: string[]) {
  return run(FFMPEG, ["-hide_banner", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });
}

export async function ffprobeJson(file: string): Promise<any> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  return JSON.parse(stdout);
}
