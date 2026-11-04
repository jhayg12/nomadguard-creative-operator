import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ffmpeg } from "../ffmpeg.js";
import { PipelineError } from "../errors.js";
import type { ProviderStatus, VideoProvider, VideoRequest, VideoResult } from "./VideoProvider.js";

/**
 * Offline provider: renders an ffmpeg test pattern with the requested length and a tone track.
 * Used for dry runs (`--provider mock`) and tests, so the whole pipeline runs with no API spend.
 * `failures` lets tests inject provider errors.
 */
export class MockVideoProvider implements VideoProvider {
  readonly name = "mock";
  submitted = 0;
  private jobs = new Map<string, { req: VideoRequest; polls: number; file?: string }>();

  constructor(
    private outDir: string,
    private opts: { pollsUntilDone?: number; width?: number; height?: number; failures?: { statusThrows?: number } } = {},
  ) {}

  async generate(req: VideoRequest) {
    this.submitted++;
    const requestId = `mock-${randomUUID()}`;
    this.jobs.set(requestId, { req, polls: 0 });
    return { requestId };
  }

  async getStatus(requestId: string): Promise<ProviderStatus> {
    const f = this.opts.failures;
    if (f?.statusThrows && f.statusThrows > 0) {
      f.statusThrows--;
      throw new PipelineError("mock: provider unreachable", { retryable: true });
    }
    const job = this.jobs.get(requestId);
    // An unknown id behaves like a provider that lost the job (e.g. after a process restart in tests).
    if (!job) return { state: "FAILED", detail: "unknown request id" };
    job.polls++;
    return job.polls >= (this.opts.pollsUntilDone ?? 1) ? { state: "COMPLETED" } : { state: "RUNNING" };
  }

  async getResult(requestId: string): Promise<VideoResult> {
    const job = this.jobs.get(requestId);
    if (!job) throw new PipelineError(`mock: unknown request ${requestId}`, { retryable: false });
    if (!job.file) {
      await mkdir(this.outDir, { recursive: true });
      const seconds = job.req.shots.reduce((t, s) => t + s.durationSec, 0);
      const w = this.opts.width ?? 720, h = this.opts.height ?? 1280;
      job.file = join(this.outDir, `${requestId}.mp4`);
      await ffmpeg([
        "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=24:duration=${seconds}`,
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", job.file,
      ]);
    }
    return { url: pathToFileURL(job.file).href, contentType: "video/mp4" };
  }
}
