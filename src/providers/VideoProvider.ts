/**
 * The only thing the pipeline knows about video generation.
 * Adding Veo / Runway / Higgsfield = one new class implementing this; the runner doesn't change.
 */
export interface VideoShot {
  prompt: string;
  durationSec: number;
}

export interface VideoRequest {
  shots: VideoShot[]; // providers without multi-shot can render each shot separately and concat
  aspectRatio: "9:16";
  negativePrompt?: string;
  audio: boolean;
}

export type ProviderJobState = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface ProviderStatus {
  state: ProviderJobState;
  detail?: string; // queue position, provider error message...
}

export interface VideoResult {
  url: string; // remote URL or file:// for local providers
  contentType?: string;
}

export interface VideoProvider {
  readonly name: string;
  /** Submit and return immediately with the provider's request id (persisted for resume). */
  generate(req: VideoRequest): Promise<{ requestId: string }>;
  getStatus(requestId: string): Promise<ProviderStatus>;
  getResult(requestId: string): Promise<VideoResult>;
}
