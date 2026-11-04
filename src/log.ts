/** Tiny structured logger. Every line is JSON so a run can be grepped or shipped to a log tool later. */
type Level = "info" | "warn" | "error";
let sink: (line: string) => void = (l) => process.stderr.write(l + "\n");

function write(level: Level, msg: string, data?: unknown) {
  if (process.env.QUIET === "1" && level === "info") return;
  sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ? { data } : {}) }));
}

export const log = {
  info: (m: string, d?: unknown) => write("info", m, d),
  warn: (m: string, d?: unknown) => write("warn", m, d),
  error: (m: string, d?: unknown) => write("error", m, d),
  setSink: (fn: (line: string) => void) => (sink = fn),
};
