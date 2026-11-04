import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/job/store.js";
import { runJob } from "../src/job/runner.js";
import { MockVideoProvider } from "../src/providers/mock.js";
import { brief, happyLlm } from "./fixtures.js";

process.env.QUIET = "1";
const fast = { pollIntervalMs: 5, backoffBaseMs: 1, maxStepAttempts: 2 };

describe("job lifecycle", () => {
  it("fails with a readable error when the provider is down, and resume re-polls the SAME render instead of paying again", async () => {
    const root = await mkdtemp(join(tmpdir(), "ng-"));
    const store = new JobStore(root);
    // Provider accepts the submission, then status polling fails 5 times in a row (outage).
    const provider = new MockVideoProvider(join(root, "_mock"), { failures: { statusThrows: 5 } });
    const job = await store.create(brief, "mock");

    const failed = await runJob(job, { store, llm: happyLlm(), provider, options: fast });

    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatchObject({ step: "GENERATING", retryable: true });
    expect(failed.error!.message).toMatch(/provider unreachable/);
    expect(failed.generation.requestId).toBeTruthy(); // persisted so resume can reuse it
    expect(provider.submitted).toBe(1);

    // Outage is over. Resume from what's on disk (fresh object, as after a process restart).
    const reloaded = await store.load(job.id);
    (provider as any).opts.failures.statusThrows = 0;
    const done = await runJob(reloaded, { store, llm: happyLlm(), provider, options: fast });

    expect(done.status).toBe("FINALIZED");
    expect(provider.submitted).toBe(1); // no second paid submission
    expect(done.history.map((h) => h.status)).toEqual(
      expect.arrayContaining(["PLANNING", "STORYBOARDING", "GENERATING", "FAILED", "ASSEMBLING", "EVALUATING", "FINALIZED"]),
    );
    const qa = await store.readJson<any>(done, "qa.json");
    expect(qa.technical.valid).toBe(true);
    expect(qa.technical.resolution).toBe("1080x1920"); // 720x1280 mock footage normalised by assembly
  }, 60_000);
});
