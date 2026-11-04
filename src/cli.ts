import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { JobStore, type Job } from "./job/store.js";
import { runJob, type RunnerDeps } from "./job/runner.js";
import { ClaudeLlm } from "./llm.js";
import { FalKlingProvider } from "./providers/falKling.js";
import { MockVideoProvider } from "./providers/mock.js";
import type { VideoProvider } from "./providers/VideoProvider.js";
import { BriefSchema } from "./schemas.js";
import { technicalQA } from "./steps/qa.js";

const HELP = `NomadGuard creative operator

Usage:
  npm start -- [--brief brief.json] [--provider fal|mock] [--no-creative-qa] [--max-regens N]
  npm run cli -- resume <jobId> [--provider fal|mock]
  npm run cli -- status <jobId>
  npm run cli -- list
  npm run cli -- qa <file.mp4>`;

export function makeProvider(name: string, store: JobStore): VideoProvider {
  if (name === "mock") return new MockVideoProvider(join(store.root, "_mock"));
  if (name === "fal") return new FalKlingProvider();
  throw new Error(`unknown provider "${name}" (use fal or mock)`);
}

export function summary(job: Job) {
  return {
    id: job.id,
    status: job.status,
    provider: job.provider,
    outputs: job.outputs,
    generation: job.generation,
    error: job.error,
    dir: join(new JobStore().root, job.id),
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      brief: { type: "string", default: "brief.json" },
      provider: { type: "string" },
      "no-creative-qa": { type: "boolean", default: false },
      "max-regens": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd = "run", arg] = positionals;
  if (values.help) return console.log(HELP);

  const store = new JobStore();
  const deps = (provider: string): RunnerDeps => ({
    store,
    llm: new ClaudeLlm(),
    provider: makeProvider(provider, store),
    options: {
      creativeQA: !values["no-creative-qa"],
      ...(values["max-regens"] !== undefined ? { maxRegenerations: Number(values["max-regens"]) } : {}),
    },
  });

  switch (cmd) {
    case "run": {
      const brief = BriefSchema.parse(JSON.parse(await readFile(values.brief!, "utf8")));
      const provider = values.provider ?? "fal";
      const job = await store.create(brief, provider);
      console.error(`job ${job.id} created -> ${store.dir(job.id)}`);
      const done = await runJob(job, deps(provider));
      return finish(done);
    }
    case "resume": {
      if (!arg) throw new Error("resume needs a job id");
      const job = await store.load(arg);
      const done = await runJob(job, deps(values.provider ?? job.provider));
      return finish(done);
    }
    case "status": {
      if (!arg) throw new Error("status needs a job id");
      return console.log(JSON.stringify(summary(await store.load(arg)), null, 2));
    }
    case "list": {
      for (const j of await store.list()) console.log(`${j.id}  ${j.status.padEnd(13)} ${j.provider}`);
      return;
    }
    case "qa": {
      if (!arg) throw new Error("qa needs a file path");
      const r = await technicalQA(arg);
      console.log(JSON.stringify({ technical: r }, null, 2));
      process.exitCode = r.valid ? 0 : 1;
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

function finish(job: Job) {
  console.log(JSON.stringify(summary(job), null, 2));
  if (job.status === "FAILED") {
    console.error(`\nJob failed at ${job.error?.step}: ${job.error?.message}`);
    console.error(`Fix the cause, then: npm run cli -- resume ${job.id}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // Last line of defence: readable message, no raw stack unless DEBUG is set.
  console.error(`error: ${err?.message ?? err}`);
  if (process.env.DEBUG) console.error(err);
  process.exitCode = 1;
});
