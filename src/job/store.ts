import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Brief } from "../schemas.js";

export const JOB_STATUSES = [
  "CREATED",
  "PLANNING",
  "STORYBOARDING",
  "GENERATING",
  "ASSEMBLING",
  "EVALUATING",
  "FINALIZED", // passed technical + creative QA
  "NEEDS_REVIEW", // technically valid, but creative QA still below threshold after the regeneration budget
  "FAILED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL: JobStatus[] = ["FINALIZED", "NEEDS_REVIEW", "FAILED"];

export interface Job {
  id: string;
  status: JobStatus;
  provider: string;
  createdAt: string;
  updatedAt: string;
  brief: Brief;
  /** Files written so far, relative to the job dir. A step whose output exists is skipped on resume. */
  outputs: {
    strategy?: string;
    storyboard?: string;
    videoRequest?: string;
    generated?: string;
    final?: string;
    qa?: string;
  };
  generation: {
    /** Provider request id is saved BEFORE polling, so a crash/resume polls the same paid job instead of resubmitting. */
    requestId?: string;
    submissions: number;
    regenerations: number;
    qaNotes?: string;
    lastProviderState?: string;
  };
  error?: { step: JobStatus; message: string; retryable: boolean; at: string; details?: unknown };
  history: { status: JobStatus; at: string; note?: string }[];
}

export class JobStore {
  constructor(readonly root = process.env.RUNS_DIR ?? "runs") {}

  dir(id: string) {
    return join(this.root, id);
  }

  async create(brief: Brief, provider: string): Promise<Job> {
    const now = new Date().toISOString();
    const id = `${now.slice(0, 19).replace(/[-:T]/g, "")}-${randomBytes(3).toString("hex")}`;
    const job: Job = {
      id, status: "CREATED", provider, createdAt: now, updatedAt: now, brief,
      outputs: {}, generation: { submissions: 0, regenerations: 0 },
      history: [{ status: "CREATED", at: now }],
    };
    await mkdir(this.dir(id), { recursive: true });
    await this.save(job);
    return job;
  }

  /** Atomic write (tmp + rename) so a crash mid-write never leaves a corrupt job.json. */
  async save(job: Job) {
    job.updatedAt = new Date().toISOString();
    const file = join(this.dir(job.id), "job.json");
    await writeFile(file + ".tmp", JSON.stringify(job, null, 2));
    await rename(file + ".tmp", file);
  }

  async load(id: string): Promise<Job> {
    return JSON.parse(await readFile(join(this.dir(id), "job.json"), "utf8"));
  }

  async list(): Promise<Job[]> {
    const ids = await readdir(this.root).catch(() => []);
    const jobs = await Promise.all(ids.map((id) => this.load(id).catch(() => null)));
    return jobs.filter((j): j is Job => !!j).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async writeJson(job: Job, name: string, data: unknown) {
    await writeFile(join(this.dir(job.id), name), JSON.stringify(data, null, 2));
    return name;
  }

  async readJson<T>(job: Job, name: string): Promise<T> {
    return JSON.parse(await readFile(join(this.dir(job.id), name), "utf8"));
  }
}
