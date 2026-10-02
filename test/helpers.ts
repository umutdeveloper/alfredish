import type { ProbeContext } from "../src/types.ts";
import { review, session } from "../src/dsl.ts";

export const s1 = session({ id: "s.2026-10-01", title: "test session", at: "2026-10-01", topic: "testing", questions: ["?"] });
export const reviewed = review({ by: "owner", at: "2026-10-01", every: "90d" });

export function fakeCtx(pages: Record<string, { status?: number; body?: string; headers?: Record<string, string> } | Error> = {}): ProbeContext {
  return {
    async fetchText(url) {
      const p = pages[url];
      if (p instanceof Error) throw p;
      if (!p) return { status: 404, headers: new Headers(), body: "" };
      return { status: p.status ?? 200, headers: new Headers(p.headers ?? {}), body: p.body ?? "" };
    },
    async fileExists(path) {
      return path.startsWith("exists/");
    },
    async run() {
      return { code: 0, stdout: "" };
    },
  };
}
