/**
 * Runs the whole pipeline with NO API keys: canned LLM answers + mock video provider.
 * Proves orchestration, assembly (captions/end card) and QA work end to end. Output lands in runs/<id>/.
 */
import { JobStore } from "../src/job/store.js";
import { runJob } from "../src/job/runner.js";
import { MockVideoProvider } from "../src/providers/mock.js";
import { MockAudioProvider } from "../src/providers/mockAudio.js";
import { brief, happyLlm } from "../test/fixtures.js";

const store = new JobStore(process.argv[2] ?? "runs");
const job = await store.create(brief, "mock");
const done = await runJob(job, {
  store,
  llm: happyLlm(),
  provider: new MockVideoProvider(`${store.root}/_mock`),
  audio: new MockAudioProvider(`${store.root}/_mock`),
  options: { pollIntervalMs: 50 },
});
console.log(`${done.status}: ${store.dir(done.id)}/final.mp4`);
