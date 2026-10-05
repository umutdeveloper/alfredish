// Real-world probe context: network, filesystem, processes. One fetch per URL per run.
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { APPROVALS_DIR, DEFAULT_ANCHOR, loadApprovals, recordName } from "./approval.ts";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { ProbeContext, SignedLookup } from "./types.ts";

/** §9.2: where the memories of this machine live — a machine's file, never part of a memory (K15). */
export const MEMORIES_FILE = process.env["ALFREDISH_MEMORIES"] ?? join(homedir(), ".alfredish", "memories.json");

/** Reads another memory's signed state; its approval records are checked against the owner's anchor first (K27). */
export async function readSigned(memory: string, id: string, pinned: string, o: { memoriesFile?: string; anchor?: string; loaded?: Map<string, ReturnType<typeof loadApprovals>> } = {}): Promise<SignedLookup> {
  let where: unknown;
  try {
    where = (JSON.parse(await readFile(o.memoriesFile ?? MEMORIES_FILE, "utf8")) as Record<string, unknown>)[memory];
  } catch {
    return { why: `no memories file at ${o.memoriesFile ?? MEMORIES_FILE}` };
  }
  if (typeof where !== "string") return { why: `memory "${memory}" is not registered in ${o.memoriesFile ?? MEMORIES_FILE}` };
  const anchor = o.anchor ?? process.env["ALFREDISH_ANCHOR"] ?? DEFAULT_ANCHOR;
  // One check of a memory's records per run: the caller's cache, never one that outlives a run.
  let loading = o.loaded?.get(`${where}\0${anchor}`);
  if (!loading) {
    loading = loadApprovals(where, anchor);
    o.loaded?.set(`${where}\0${anchor}`, loading);
  }
  const { state, issues } = await loading;
  if (!state) return { why: `${memory} has no approval records` };
  if (issues.length) return { why: `${memory}'s approval records do not check out (${issues[0]!.message})` };
  const now = state.items.get(id);
  if (!now) return { why: `not in ${memory}'s signed state (removed, or never approved)` };
  // The earlier signed content at the pinned hash, from the records, so a change can be shown field by field.
  let was: Readonly<Record<string, unknown>> | undefined;
  for (let n = 1; n <= state.records && !was; n++) {
    const rec = JSON.parse(await readFile(join(where, APPROVALS_DIR, recordName(n)), "utf8")) as { approved?: Record<string, { hash: string; data: Record<string, unknown> }> };
    const item = rec.approved?.[id];
    if (item?.hash === pinned) was = item.data;
  }
  return was ? { hash: now.hash, data: now.data, was } : { hash: now.hash, data: now.data };
}

export function nodeContext(baseDir: string, timeoutMs = 15_000): ProbeContext {
  const pages = new Map<string, Promise<{ status: number; headers: Headers; body: string }>>();
  const signedCache = new Map<string, Promise<SignedLookup>>();
  const loaded = new Map<string, ReturnType<typeof loadApprovals>>();
  return {
    signed(memory, id, pinned) {
      const k = `${memory}\0${id}\0${pinned}`;
      let p = signedCache.get(k);
      if (!p) signedCache.set(k, (p = readSigned(memory, id, pinned, { loaded })));
      return p;
    },
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
    async readText(path) {
      return readFile(resolve(baseDir, path), "utf8").catch(() => undefined);
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
