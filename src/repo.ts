// Checks that need the memory repository on disk: K5 (past is immutable), K6 (views are generated), K15 (self-contained);
// areas and the probe cache (SPEC §9).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDef, type Issue } from "./compiler.ts";
import { diffSnapshots, snapshot, type DiffLine, type Snapshot } from "./snapshot.ts";
import { bodyHash, parseGenerated, render, type View } from "./views.ts";
import { typeEscapes } from "./escapes.ts";
import { looksLikeDef } from "./validate.ts";
import { embedder, KEY_SIMILARITY_THRESHOLD, keyText, rank, type Embed } from "./similarity.ts";
import type { Def, ISODate, KeyDef, ProbeCache, ProbeContext } from "./types.ts";

const run = promisify(execFile);
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

const PRESENT_KINDS = new Set(["fact", "claim", "decision", "promise", "goal", "idea", "account", "asset", "rule"]);
const refId = (x: unknown) => (typeof x === "string" && x.startsWith("@") ? x.slice(1) : undefined);

/**
 * K20 (nothing disappears silently) and K21 (no back-dating), compared with the last commit.
 * K20: a present-tense definition in HEAD that is gone must be listed in `retires` of an event dated today.
 * K21: a definition new since HEAD must be born in a session that is new since HEAD or dated today.
 */
export async function checkHistory(snap: Snapshot, today: ISODate, o: RepoOptions): Promise<Issue[]> {
  const head = await snapshotAt("HEAD", o);
  if (!head) return [];
  const issues: Issue[] = [];
  const retired = new Set<string>();
  for (const e of Object.values(snap)) {
    if (e.kind === "event" && e.data["at"] === today && Array.isArray(e.data["retires"])) for (const id of e.data["retires"]) retired.add(String(id));
  }
  for (const [id, old] of Object.entries(head)) {
    if (!PRESENT_KINDS.has(old.kind) || snap[id] || retired.has(id)) continue;
    issues.push({ id, status: "red", rule: "K20", message: `removed since the last commit — record it in an event dated ${today} with retires: ["${id}"] and say why` });
  }
  for (const [id, now] of Object.entries(snap)) {
    if (head[id] || now.kind === "session") continue;
    const origin = refId(now.data["origin"]);
    const born = origin ? head[origin] : undefined;
    if (born && born.data["at"] !== today) {
      issues.push({ id, status: "red", rule: "K21", message: `new, but born in ${origin} (${String(born.data["at"])}), which is already committed — use the current session as origin` });
    }
  }
  return issues;
}

/**
 * K23: a key new since the last commit must decide, in distinctFrom, every key of the same subject that is at least
 * KEY_SIMILARITY_THRESHOLD similar. If the model cannot be used, every new key is red: it never passes unseen.
 */
export async function checkNewKeys(defs: readonly Def[], o: RepoOptions, embed: () => Promise<Embed> = embedder): Promise<Issue[]> {
  const head = (await snapshotAt("HEAD", o)) ?? {};
  const keys = defs.filter((d): d is KeyDef => d.kind === "key");
  const fresh = keys.filter((k) => !head[k.id]);
  if (!fresh.length) return [];
  let e: Embed;
  try {
    e = await embed();
  } catch (err) {
    return fresh.map((k) => ({ id: k.id, status: "red", rule: "K23", message: `cannot compare keys: ${(err as Error).message}` }));
  }
  const issues: Issue[] = [];
  for (const k of fresh) {
    const others = keys.filter((x) => x.subject === k.subject && x !== k);
    // A pair is decided once, from either side: k lists the candidate, or the candidate lists k.
    const decided = (other: KeyDef) => (k.distinctFrom ?? []).some((x) => x.id === other.id) || (other.distinctFrom ?? []).some((x) => x.id === k.id);
    const close = (await rank(e, keyText(k), others)).filter((r) => r.score >= KEY_SIMILARITY_THRESHOLD);
    const open = close.filter((r) => !decided(r.key));
    if (open.length) {
      const list = open.map((r) => `${r.key.id} (${r.score.toFixed(2)})`).join(", ");
      issues.push({ id: k.id, status: "red", rule: "K23", message: `new key is close to: ${list} — use one of them, or add them to distinctFrom` });
    }
  }
  return issues;
}

/** K18: every definition exported from a file under the memory folder is reachable from the index. */
export async function checkReachable(memoryDirAbs: string, reached: ReadonlySet<unknown>, base: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const f of (await tsFiles(memoryDirAbs).catch(() => [] as string[])).sort()) {
    const mod = (await import(pathToFileURL(f).href)) as Record<string, unknown>;
    const rel = relative(base, f).split(sep).join("/");
    for (const x of Object.values(mod)) {
      if (looksLikeDef(x) && !reached.has(x)) {
        issues.push({ id: String(x["id"]), status: "red", rule: "K18", message: `defined in ${rel} but not reachable from the index — export it from the index` });
      }
    }
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

/**
 * K15: a memory loads nothing from outside its own folder.
 * Structural: the TypeScript compiler lists every source file of the program built from the memory's
 * tsconfig.json; any file outside the folder, other than installed libraries (node_modules), is red.
 */
export async function checkImports(o: RepoOptions): Promise<Issue[]> {
  const root = resolvePath(o.base);
  if (!existsSync(join(root, "tsconfig.json"))) {
    return [{ id: "tsconfig.json", status: "red", rule: "K15", message: "no tsconfig.json: the memory's program cannot be inspected" }];
  }
  const local = join(root, "node_modules", "typescript", "bin", "tsc");
  const tsc = existsSync(local) ? local : join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  const { stdout } = await run(process.execPath, [tsc, "-p", join(root, "tsconfig.json"), "--listFilesOnly"], { maxBuffer: 16 << 20 });
  const issues: Issue[] = [];
  for (const line of stdout.split("\n")) {
    const f = line.trim();
    if (!f) continue;
    const inside = f === root || f.startsWith(root + sep);
    const library = f.split(sep).includes("node_modules");
    if (!inside && !library) {
      issues.push({ id: f, status: "red", rule: "K15", message: "the memory's program loads this file from outside the memory folder" });
    }
  }
  return issues;
}

/** K17: no type escapes in the memory's own source files (the pinned alfredish copy is not memory). */
export async function checkTypeEscapes(o: RepoOptions): Promise<Issue[]> {
  const dir = join(o.base, o.memoryDir);
  const issues: Issue[] = [];
  for (const f of (await tsFiles(dir).catch(() => [] as string[])).sort()) {
    const rel = relative(o.base, f).split(sep).join("/");
    for (const e of typeEscapes(await readFile(f, "utf8"))) {
      issues.push({ id: `${rel}:${e.line}`, status: "red", rule: "K17", message: `${e.what} — remove the escape and fix the type error it hides` });
    }
  }
  return issues;
}

// ---- areas and the probe cache (SPEC §9) ----

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The definitions exported from an area's files (sub-folders included), or an error line. */
export async function areaDefs(memoryDirAbs: string, area: string): Promise<Set<Def> | string> {
  const dirs = (await tsFiles(memoryDirAbs).catch(() => [] as string[]))
    .map((f) => relative(memoryDirAbs, dirname(f)).split(sep).join("/"))
    .flatMap((d) => d.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")))
    .filter((d, i, all) => d !== "" && all.indexOf(d) === i);
  const exact = dirs.filter((d) => d === area);
  const bySegment = dirs.filter((d) => d.split("/").pop() === area);
  const found = exact.length ? exact : bySegment;
  if (found.length === 0) return `no area "${area}" under the memory folder`;
  if (found.length > 1) return `area "${area}" is ambiguous: ${found.join(", ")}`;
  const defs = new Set<Def>();
  for (const f of await tsFiles(join(memoryDirAbs, found[0]!))) {
    const mod = (await import(pathToFileURL(f).href)) as Record<string, unknown>;
    for (const x of Object.values(mod)) if (isDef(x)) defs.add(x);
  }
  return defs;
}

const CACHE_FILE = ".alfredish-cache.json";

export async function loadProbeCache(base: string): Promise<ProbeCache> {
  try {
    return JSON.parse((await readOrUndefined(join(base, CACHE_FILE))) ?? "{}") as ProbeCache;
  } catch {
    return {};
  }
}

export async function saveProbeCache(base: string, cache: ProbeCache): Promise<void> {
  await writeFile(join(base, CACHE_FILE), JSON.stringify(cache, null, 2) + "\n");
}
