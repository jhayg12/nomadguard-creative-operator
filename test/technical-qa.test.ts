import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpeg } from "../src/ffmpeg.js";
import { technicalQA } from "../src/steps/qa.js";

let dir: string;
const clip = async (name: string, size: string, seconds: number) => {
  const out = join(dir, name);
  await ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=24:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
  ]);
  return out;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ng-qa-"));
});

describe("technical QA", () => {
  it("passes a 12s 1080x1920 clip", async () => {
    const r = await technicalQA(await clip("ok.mp4", "1080x1920", 12));
    expect(r).toMatchObject({ exists: true, playable: true, resolution: "1080x1920", aspect_ratio: "9:16", valid: true });
    expect(r.duration).toBeCloseTo(12, 0);
  }, 60_000);

  it("fails landscape and too-short clips with specific reasons", async () => {
    const landscape = await technicalQA(await clip("wide.mp4", "1920x1080", 12));
    expect(landscape.valid).toBe(false);
    expect(landscape.errors.join(" ")).toMatch(/aspect ratio 16:9 is not 9:16/);

    const short = await technicalQA(await clip("short.mp4", "1080x1920", 5));
    expect(short.valid).toBe(false);
    expect(short.errors.join(" ")).toMatch(/duration 5s is outside 10-15s/);
  }, 60_000);

  it("reports a missing or corrupt file instead of throwing", async () => {
    expect((await technicalQA(join(dir, "nope.mp4"))).errors).toContain("file does not exist");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "broken.mp4"), "not a video");
    const broken = await technicalQA(join(dir, "broken.mp4"));
    expect(broken.valid).toBe(false);
    expect(broken.playable).toBe(false);
  }, 60_000);
});
