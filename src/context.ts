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

/**
 * K12: the ids of this memory that other memories registered on this machine link to in their signed state — what
 * they rest on here. A memory whose records do not check out adds nothing (its own check is red).
 */
export async function linkedFromOthers(base: string, o: { memoriesFile?: string; anchor?: string } = {}): Promise<Set<string>> {
  const out = new Set<string>();
  let reg: Record<string, unknown>;
  try {
    reg = JSON.parse(await readFile(o.memoriesFile ?? MEMORIES_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return out;
  }
  const here = resolve(base);
  const names = Object.entries(reg).filter(([, w]) => typeof w === "string" && resolve(w) === here).map(([n]) => n);
  if (!names.length) return out;
  const anchor = o.anchor ?? process.env["ALFREDISH_ANCHOR"] ?? DEFAULT_ANCHOR;
  for (const [, where] of Object.entries(reg)) {
    if (typeof where !== "string" || resolve(where) === here) continue;
    const { state, issues } = await loadApprovals(where, anchor);
    if (!state || issues.length) continue;
    for (const it of state.items.values()) {
      const d = it.data;
      if (it.kind === "link" && names.includes(String(d["memory"])) && typeof d["target"] === "string") out.add(d["target"]);
    }
  }
  return out;
}

/** §9.3: the memories registered on this machine, each with its identity rule as its owner signed it. */
export async function memoriesOnMachine(base: string, o: { memoriesFile?: string; anchor?: string } = {}): Promise<{ name: string; here: boolean; identity: string }[]> {
  let reg: Record<string, unknown>;
  try {
    reg = JSON.parse(await readFile(o.memoriesFile ?? MEMORIES_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const anchor = o.anchor ?? process.env["ALFREDISH_ANCHOR"] ?? DEFAULT_ANCHOR;
  const out: { name: string; here: boolean; identity: string }[] = [];
  for (const [name, where] of Object.entries(reg).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof where !== "string") continue;
    const { state, issues } = await loadApprovals(where, anchor);
    const id = !issues.length ? state?.items.get("rule.identity") : undefined;
    out.push({ name, here: resolve(where) === resolve(base), identity: id ? String(id.data["text"] ?? "") : "(no signed identity rule yet)" });
  }
  return out;
}

// 30 s: some sites answer through a redirect in 10-20 s (YouTube's channel pages); probes run in parallel, so a slow
// site costs one wait, not one per probe.
export function nodeContext(baseDir: string, timeoutMs = 30_000): ProbeContext {
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
