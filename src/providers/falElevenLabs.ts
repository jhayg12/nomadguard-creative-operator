import { fal } from "@fal-ai/client";
import { PipelineError, toPipelineError } from "../errors.js";
import type { AudioProvider, AudioResult } from "./AudioProvider.js";

/** ElevenLabs TTS (multilingual v2) and ElevenLabs Music through fal. Short jobs, so `subscribe` (submit + wait) is fine. */
export class FalElevenLabsAudio implements AudioProvider {
  readonly name = "fal-elevenlabs";

  constructor() {
    if (!process.env.FAL_KEY) throw new PipelineError("FAL_KEY is not set (see .env.example)", { retryable: false });
    fal.config({ credentials: process.env.FAL_KEY });
  }

  async speech(req: { text: string; voice?: string; speed?: number }): Promise<AudioResult> {
    try {
      const r = await fal.subscribe("fal-ai/elevenlabs/tts/multilingual-v2", {
        input: {
          text: req.text,
          voice: req.voice ?? process.env.VO_VOICE ?? "Sarah",
          speed: req.speed ?? 1,
          stability: 0.55,
          similarity_boost: 0.75,
          style: 0.25,
        },
      });
      return { url: (r.data as { audio: { url: string } }).audio.url };
    } catch (err) {
      throw toPipelineError(err, "fal tts");
    }
  }

  async music(req: { prompt: string; durationMs: number }): Promise<AudioResult> {
    try {
      const r = await fal.subscribe("fal-ai/elevenlabs/music", {
        input: { prompt: req.prompt, music_length_ms: Math.round(req.durationMs), force_instrumental: true },
      });
      return { url: (r.data as { audio: { url: string } }).audio.url };
    } catch (err) {
      throw toPipelineError(err, "fal music");
    }
  }
}
