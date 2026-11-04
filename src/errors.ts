/**
 * One error type for the whole pipeline. `retryable` drives the runner:
 * retryable errors are retried with backoff, the rest fail the job immediately
 * with a readable message instead of a stack trace.
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    readonly opts: { retryable: boolean; cause?: unknown; details?: unknown; resumeFrom?: string } = { retryable: false },
  ) {
    super(message);
    this.name = "PipelineError";
  }
  get retryable() {
    return this.opts.retryable;
  }
}

export function toPipelineError(err: unknown, context: string): PipelineError {
  if (err instanceof PipelineError) return err;
  const e = err as { status?: number; message?: string; code?: string; body?: unknown };
  const status = typeof e?.status === "number" ? e.status : undefined;
  // Network errors, 408/409/429 and 5xx are worth retrying; 4xx validation/auth errors are not.
  const retryable =
    status === undefined
      ? ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(e?.code ?? "") ||
        /fetch failed|network|socket|timed? ?out/i.test(e?.message ?? "")
      : status === 408 || status === 409 || status === 429 || status >= 500;
  // Provider validation errors (e.g. fal 422) carry the useful part in the body: keep it in the message.
  const body = e?.body ? ` - ${JSON.stringify(e.body).slice(0, 400)}` : "";
  return new PipelineError(`${context}: ${e?.message ?? String(err)}${status ? ` (HTTP ${status})` : ""}${body}`, {
    retryable,
    cause: err,
    details: e?.body,
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: 1s, 2s, 4s ... capped. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 30_000) {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}
