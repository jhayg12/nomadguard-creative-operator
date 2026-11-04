import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { PipelineError, toPipelineError } from "./errors.js";
import { log } from "./log.js";

export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

export interface LlmRequest<S extends z.ZodType> {
  label: string;
  system: string;
  content: string | ContentBlock[];
  schema: S;
}

/** Anything that can return JSON shaped like `schema`. Real impl = Claude; tests use a stub. */
export interface StructuredLlm {
  complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<unknown>;
}

export class ClaudeLlm implements StructuredLlm {
  private client = new Anthropic({ maxRetries: 3 }); // SDK retries 429/5xx/network with backoff
  constructor(private model = process.env.PLANNER_MODEL ?? "claude-opus-5-5") {}

  async complete<S extends z.ZodType>(req: LlmRequest<S>): Promise<unknown> {
    const started = Date.now();
    try {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // a safety-classifier refusal is re-run on a fallback model server-side
        output_config: { effort: "high", format: betaZodOutputFormat(req.schema) },
        system: req.system,
        messages: [{ role: "user", content: req.content }],
      });
      log.info(`llm:${req.label}`, {
        model: res.model,
        ms: Date.now() - started,
        in: res.usage.input_tokens,
        out: res.usage.output_tokens,
        stop: res.stop_reason,
      });
      if (res.stop_reason === "refusal")
        throw new PipelineError(`${req.label}: model refused (${res.stop_details?.category ?? "unknown"})`, {
          retryable: false,
        });
      if (res.stop_reason === "max_tokens")
        throw new PipelineError(`${req.label}: output truncated at max_tokens`, { retryable: true });
      if (res.parsed_output == null)
        throw new PipelineError(`${req.label}: response did not contain parseable JSON`, { retryable: true });
      return res.parsed_output;
    } catch (err) {
      throw toPipelineError(err, `llm:${req.label}`);
    }
  }
}

/**
 * Ask for structured output, then enforce the business rules the JSON schema can't express
 * (counts, duration totals...). On a violation, retry with the exact errors appended so the
 * model can repair its own output. Bounded: never loops forever, never silently accepts bad output.
 */
export async function generateValidated<S extends z.ZodType>(
  llm: StructuredLlm,
  req: LlmRequest<S>,
  rules: (value: z.infer<S>) => string[],
  maxAttempts = 3,
): Promise<z.infer<S>> {
  let content = req.content;
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await llm.complete({ ...req, content });
    const parsed = req.schema.safeParse(raw);
    lastErrors = parsed.success
      ? rules(parsed.data)
      : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    if (lastErrors.length === 0) return parsed.data as z.infer<S>;

    log.warn(`llm:${req.label} attempt ${attempt} rejected`, { errors: lastErrors });
    const feedback =
      `Your previous answer was rejected by validation:\n- ${lastErrors.join("\n- ")}\n` +
      `Previous answer:\n${JSON.stringify(raw)}\nReturn a corrected answer that fixes every issue.`;
    content = appendText(req.content, feedback);
  }
  throw new PipelineError(`${req.label}: output failed validation after ${maxAttempts} attempts`, {
    retryable: false,
    details: lastErrors,
  });
}

function appendText(content: string | ContentBlock[], text: string): string | ContentBlock[] {
  if (typeof content === "string") return `${content}\n\n${text}`;
  return [...content, { type: "text", text }];
}
