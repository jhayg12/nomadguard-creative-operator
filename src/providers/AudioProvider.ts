/**
 * Sound design providers (voice-over + music), kept behind an interface like VideoProvider
 * so ElevenLabs can be swapped for another TTS / music model without touching the pipeline.
 */
export interface AudioResult {
  url: string; // remote URL or file:// for local providers
}

export interface AudioProvider {
  readonly name: string;
  speech(req: { text: string; voice?: string; speed?: number }): Promise<AudioResult>;
  music(req: { prompt: string; durationMs: number }): Promise<AudioResult>;
}
