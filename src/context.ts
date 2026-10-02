// Real-world probe context: network, filesystem, processes. One fetch per URL per run.
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { ProbeContext } from "./types.ts";

export function nodeContext(baseDir: string, timeoutMs = 15_000): ProbeContext {
  const pages = new Map<string, Promise<{ status: number; headers: Headers; body: string }>>();
  return {
    fetchText(url) {
      let p = pages.get(url);
      if (!p) {
        p = (async () => {
          const r = await fetch(url, {
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "user-agent": "Mozilla/5.0 (alfredish check)", accept: "text/html,*/*" },
          });
          return { status: r.status, headers: r.headers, body: await r.text() };
        })();
        pages.set(url, p);
      }
      return p;
    },
    async fileExists(path) {
      try {
        await access(resolve(baseDir, path));
        return true;
      } catch {
        return false;
      }
    },
    run(cmd, args, cwd) {
      return new Promise((done) => {
        execFile(cmd, args, { cwd: resolve(baseDir, cwd ?? ".") }, (err, stdout) => {
          done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout) });
        });
      });
    },
  };
}
