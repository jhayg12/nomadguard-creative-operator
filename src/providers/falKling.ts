import { fal } from "@fal-ai/client";
import { PipelineError, toPipelineError } from "../errors.js";
import type { ProviderStatus, VideoProvider, VideoRequest, VideoResult } from "./VideoProvider.js";

/**
 * Kling v3 Pro text-to-video through fal.ai's queue API.
 * Uses Kling's multi-shot mode: every storyboard shot is rendered in ONE generation, which keeps the
 * same person, wardrobe and grade across cuts (the biggest weakness of stitching separate clips).
 */
type KlingDuration = "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15";
type ShotDuration = "1" | "2" | KlingDuration;

export class FalKlingProvider implements VideoProvider {
  readonly name = "fal-kling-v3-pro";
  private endpoint = process.env.KLING_ENDPOINT ?? "fal-ai/kling-video/v3/pro/text-to-video";

  constructor() {
    if (!process.env.FAL_KEY) throw new PipelineError("FAL_KEY is not set (see .env.example)", { retryable: false });
    fal.config({ credentials: process.env.FAL_KEY });
  }

  async generate(req: VideoRequest): Promise<{ requestId: string }> {
    const total = req.shots.reduce((t, s) => t + s.durationSec, 0);
    if (total < 3 || total > 15) throw new PipelineError(`Kling supports 3-15s per generation, got ${total}s`, { retryable: false });
    try {
      const { request_id } = await fal.queue.submit(this.endpoint as "fal-ai/kling-video/v3/pro/text-to-video", {
        input: {
          multi_prompt: req.shots.map((s) => ({ prompt: s.prompt, duration: String(s.durationSec) as ShotDuration })),
          shot_type: "customize",
          duration: String(total) as KlingDuration,
          aspect_ratio: req.aspectRatio,
          negative_prompt: req.negativePrompt,
          generate_audio: req.audio,
        },
      });
      return { requestId: request_id };
    } catch (err) {
      throw toPipelineError(err, "fal submit");
    }
  }

  async getStatus(requestId: string): Promise<ProviderStatus> {
    try {
      const s = await fal.queue.status(this.endpoint, { requestId, logs: false });
      if (s.status === "IN_QUEUE") return { state: "QUEUED", detail: `queue position ${s.queue_position}` };
      if (s.status === "IN_PROGRESS") return { state: "RUNNING" };
      // COMPLETED also covers provider-side failures; getResult() surfaces the error body.
      return { state: "COMPLETED" };
    } catch (err) {
      throw toPipelineError(err, "fal status");
    }
  }

  async getResult(requestId: string): Promise<VideoResult> {
    try {
      const r = await fal.queue.result(this.endpoint as "fal-ai/kling-video/v3/pro/text-to-video", { requestId });
      const video = (r.data as { video?: { url?: string; content_type?: string } }).video;
      if (!video?.url) throw new PipelineError(`fal returned no video for ${requestId}`, { retryable: true, details: r.data });
      return { url: video.url, contentType: video.content_type };
    } catch (err) {
      // A failed generation (e.g. content moderation) arrives here as a 4xx/422 -> not retryable as-is.
      throw toPipelineError(err, "fal result");
    }
  }
}
