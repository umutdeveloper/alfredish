// Checks that need the memory repository on disk: K5 (past is immutable), K6 (views are generated).
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import type { Issue } from "./compiler.ts";
import { diffSnapshots, snapshot, type DiffLine, type Snapshot } from "./snapshot.ts";
import { bodyHash, parseGenerated, render, type View } from "./views.ts";
import type { Def, ISODate, ProbeContext } from "./types.ts";

const PAST = new Set(["session", "event", "research"]);

export interface RepoOptions {
  base: string; // memory repository root
  memoryDir: string; // where definitions live, relative to base (e.g. "memory")
  ctx: ProbeContext;
}

const snapshotPath = (o: RepoOptions) => join(o.memoryDir, "snapshot.json");
const snapshotText = (s: Snapshot) => JSON.stringify(s, null, 2) + "\n";

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** K6: every view exists, is untouched and up to date; no stray generated files. */
export async function checkViews(views: readonly View[], snap: Snapshot, o: RepoOptions): Promise<Issue[]> {
  const issues: Issue[] = [];
  const red = (id: string, message: string) => issues.push({ id, status: "red", rule: "K6", message });
  for (const v of views) {
    const text = await readOrUndefined(join(o.base, v.path));
    if (text === undefined) {
      red(v.path, "not generated (alfred build)");
      continue;
    }
    const g = parseGenerated(text);
    if (!g) red(v.path, "hand-written; this file must be generated (alfred build)");
    else if (g.hash !== bodyHash(g.body)) red(v.path, "edited by hand");
    else if (v.deterministic && g.body !== v.body) red(v.path, "stale (alfred build)");
  }
  const expected = new Set(views.map((v) => v.path));
  for (const dir of ["sessions", "library"]) {
    let names: string[] = [];
    try {
      names = await readdir(join(o.base, dir));
    } catch {
      continue;
    }
    for (const n of names.filter((x) => x.endsWith(".md"))) {
      const p = `${dir}/${n}`;
      if (!expected.has(p)) red(p, "generated from no definition (hand-written, or its definition is gone)");
    }
  }
  const s = await readOrUndefined(join(o.base, snapshotPath(o)));
  if (s !== snapshotText(snap)) red(snapshotPath(o), s === undefined ? "not generated (alfred build)" : "stale or edited by hand (alfred build)");
  return issues;
}

async function snapshotAt(ref: string, o: RepoOptions): Promise<Snapshot | undefined> {
  const r = await o.ctx.run("git", ["show", `${ref}:./${snapshotPath(o)}`], o.base);
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout) as Snapshot;
  } catch {
    return undefined;
  }
}

/** K5: a session/event/research whose day has passed may not change or disappear (compared with HEAD). */
export async function checkPast(snap: Snapshot, today: ISODate, o: RepoOptions): Promise<Issue[]> {
  const head = await snapshotAt("HEAD", o);
  if (!head) return [];
  const issues: Issue[] = [];
  for (const [id, old] of Object.entries(head)) {
    if (!PAST.has(old.kind)) continue;
    const at = String(old.data["at"] ?? "");
    if (!(at < today)) continue; // same day: corrections allowed
    const now = snap[id];
    if (!now) issues.push({ id, status: "red", rule: "K5", message: `past deleted (${at})` });
    else if (now.hash !== old.hash) issues.push({ id, status: "red", rule: "K5", message: `past changed (${at})` });
  }
  return issues;
}

export async function writeViews(views: readonly View[], snap: Snapshot, o: RepoOptions): Promise<string[]> {
  const changed: string[] = [];
  const put = async (rel: string, text: string) => {
    const path = join(o.base, rel);
    if ((await readOrUndefined(path)) === text) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    changed.push(rel);
  };
  for (const v of views) await put(v.path, render(v));
  await put(snapshotPath(o), snapshotText(snap));
  return changed;
}

/** `alfred diff a..b`: a/b are git refs or YYYY-MM-DD (last commit of that day); b defaults to the working memory. */
export async function diff(defs: readonly Def[], range: string, o: RepoOptions): Promise<DiffLine[] | string> {
  const [a, b] = range.split("..");
  const resolve = async (ref: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) {
      const r = await o.ctx.run("git", ["rev-list", "-1", `--before=${ref} 23:59:59`, "HEAD"], o.base);
      return r.stdout.trim() || undefined;
    }
    return ref;
  };
  const ra = a ? await resolve(a) : undefined;
  const from = ra ? await snapshotAt(ra, o) : undefined;
  if (!from) return `? no record for ${a ?? ""}`;
  let to: Snapshot | undefined = snapshot(defs);
  if (b) {
    const rb = await resolve(b);
    to = rb ? await snapshotAt(rb, o) : undefined;
    if (!to) return `? no record for ${b}`;
  }
  return diffSnapshots(from, to);
}

/** K15: a memory imports nothing outside its own folder. */
export async function checkImports(o: RepoOptions): Promise<Issue[]> {
  const issues: Issue[] = [];
  const root = resolvePath(o.base);
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  let files: string[] = [];
  try {
    files = await walk(join(root, o.memoryDir));
  } catch {
    return issues;
  }
  // Static imports/re-exports at the start of a line, and dynamic import("…") calls.
  const IMPORT = /^\s*(?:import|export)\b[^"'\n;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
  for (const f of files) {
    const text = await readFile(f, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2] ?? m[3])!;
      if (spec.startsWith("node:")) continue;
      const target = spec.startsWith(".") ? resolvePath(dirname(f), spec) : spec.startsWith("/") ? spec : undefined;
      const inside = target !== undefined && (target === root || target.startsWith(root + sep));
      if (!inside) {
        issues.push({ id: relative(root, f), status: "red", rule: "K15", message: `imports "${spec}" from outside the memory folder` });
      }
    }
  }
  return issues;
}
