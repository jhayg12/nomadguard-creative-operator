import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ffmpeg } from "../ffmpeg.js";
import type { AudioProvider, AudioResult } from "./AudioProvider.js";

/** Offline audio: a short tone stands in for speech, a low drone for music. */
export class MockAudioProvider implements AudioProvider {
  readonly name = "mock-audio";
  constructor(private outDir: string) {}

  private async tone(seconds: number, freq: number): Promise<AudioResult> {
    await mkdir(this.outDir, { recursive: true });
    const file = join(this.outDir, `${randomUUID()}.mp3`);
    await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-c:a", "libmp3lame", file]);
    return { url: pathToFileURL(file).href };
  }

  speech(req: { text: string }) {
    return this.tone(Math.max(1, req.text.split(/\s+/).length / 2.5), 660);
  }

  music(req: { durationMs: number }) {
    return this.tone(req.durationMs / 1000, 110);
  }
}
