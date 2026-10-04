// SPEC §14 `alfred approve`: the owner's approval round. The core (what changed, the record a set of decisions makes)
// is plain functions so it can be tested with throwaway keys; the terminal dialogue is a thin layer on top.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface, emitKeypressEvents } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { entriesFor, newScreen, render, step, VENDOR_KEY, type Key } from "./approve-screen.ts";
import { APPROVALS_DIR, hashTree, readAnchor, recordName, run, sha256, signFile, type ApprovalRecord, type ApprovedState } from "./approval.ts";
import { diffSnapshots, type Snapshot } from "./snapshot.ts";
import type { ISODate } from "./types.ts";

export type Op = "+" | "~" | "-";
export interface Change {
  id: string;
  op: Op;
  kind: string;
  /** Owner's calls come first; machine-checked lines can be approved together. */
  group: "owner" | "machine";
  /** What changed, field by field (for "~"), or the title (for "+" / "-"). */
  detail: string;
  /** The test, shown for machine-checked lines. */
  test?: string;
  why?: string;
  /** A correction note the owner wrote last time, shown above the new version. */
  note?: string;
  /** What the owner signs, never shortened: every field of a new or removed definition, every changed field. */
  shown: string[];
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** How removed and added words are marked: colours in a terminal, git's word-diff marks elsewhere. */
export interface Marks {
  gone: (s: string) => string;
  added: (s: string) => string;
}
export const PLAIN: Marks = { gone: (s) => `[-${s}-]`, added: (s) => `{+${s}+}` };
export const COLOURS: Marks = { gone: (s) => `\x1b[31;9m${s}\x1b[0m`, added: (s) => `\x1b[32m${s}\x1b[0m` };

/**
 * A changed text, whole, with the removed words and the added words marked where they are — so it reads as one
 * text, not as fragments. Words are matched by longest common subsequence.
 */
export function textChange(before: string, after: string, marks: Marks = PLAIN): string {
  const a = before.split(" ");
  const b = after.split(" ");
  const n = a.length, m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: string[] = [];
  let gone: string[] = [], added: string[] = [];
  const flush = () => {
    if (gone.length) out.push(marks.gone(gone.join(" ")));
    if (added.length) out.push(marks.added(added.join(" ")));
    gone = [];
    added = [];
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      out.push(a[i]!);
      i++;
      j++;
    } else if (j < m && (i === n || L[i]![j + 1]! >= L[i + 1]![j]!)) added.push(b[j++]!);
    else gone.push(a[i++]!);
  }
  flush();
  return out.join(" ");
}

function shownFor(op: Op, was: Record<string, unknown> | undefined, now: Record<string, unknown> | undefined, marks: Marks): string[] {
  if (op !== "~") {
    const data = (op === "+" ? now : was) ?? {};
    // Lists and maps of text read as lines; the id and kind are already in the heading.
    return Object.entries(data).filter(([k]) => k !== "id" && k !== "kind").flatMap(([k, v]) => {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return [`${k}:`, ...v.map((x) => `  - ${x}`)];
      if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string")) return [`${k}:`, ...Object.entries(v).map(([a, b]) => `  ${a}: ${String(b)}`)];
      return [`${k}: ${show(v)}`];
    });
  }
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})])].sort()) {
    const x = was?.[k];
    const y = now?.[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (typeof x === "string" && typeof y === "string") out.push(`${k}: ${textChange(x, y, marks)}`);
    else out.push(`${k}: ${[x !== undefined ? marks.gone(show(x)) : "", y !== undefined ? marks.added(show(y)) : ""].filter(Boolean).join(" ")}`);
  }
  return out;
}

const OWNER_KINDS = new Set(["decision", "rule", "promise", "goal", "idea", "key", "event", "research", "session"]);
const isLocal = (x: unknown) => typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "local";

/** The group a change belongs to — by kind and verification, never by text. */
export function groupOf(op: Op, kind: string, data: Record<string, unknown> | undefined): "owner" | "machine" {
  if (op === "-" || OWNER_KINDS.has(kind) || !data) return "owner";
  if (isLocal(data["location"]) || isLocal(data["where"])) return "owner";
  // Machine-checked only when a built-in probe looks at the world (not cmd, whose command the owner must judge).
  const verify = String(data["verify"] ?? "");
  return /^(page|http|header|file|git) /.test(verify) && !verify.includes(" — runs: ") ? "machine" : "owner";
}

function reasons(snap: Snapshot): Map<string, string> {
  const out = new Map<string, string>();
  const sessions = Object.values(snap).filter((e) => e.kind === "session").sort((a, b) => String(a.data["at"]).localeCompare(String(b.data["at"])));
  for (const s of sessions) for (const [id, why] of Object.entries((s.data["changes"] as Record<string, string> | undefined) ?? {})) out.set(id, why);
  return out;
}

/** Every difference between the memory now and what the owner last signed, owner's calls first. */
export function changesSince(state: ApprovedState | undefined, snap: Snapshot, marks: Marks = PLAIN): Change[] {
  const approved: Snapshot = {};
  for (const [id, it] of state?.items ?? []) approved[id] = { kind: it.kind, hash: it.hash, data: it.data };
  const why = reasons(snap);
  const out: Change[] = diffSnapshots(approved, snap).map((d) => {
    const data = snap[d.id]?.data;
    const c: Change = { id: d.id, op: d.op, kind: d.kind, group: groupOf(d.op, d.kind, data), detail: d.detail, shown: shownFor(d.op, approved[d.id]?.data, data, marks) };
    if (data && c.group === "machine") c.test = String(data["verify"] ?? "");
    const w = why.get(d.id);
    if (w) c.why = w;
    const note = state?.corrections.get(d.id)?.note;
    if (note) c.note = note;
    return c;
  });
  return out.sort((a, b) => (a.group === b.group ? a.id.localeCompare(b.id) : a.group === "owner" ? -1 : 1));
}

export type Decision = { kind: "approve" } | { kind: "correct"; note: string } | { kind: "reject"; note?: string } | { kind: "skip" };

/** The record a round of decisions makes. Removals can only be approved (or skipped). */
export function buildRecord(state: ApprovedState | undefined, snap: Snapshot, changes: readonly Change[], decisions: ReadonlyMap<string, Decision>, at: ISODate, alfredish: { now: string | null; approve: boolean; pinned?: string | null }, prevText?: string): ApprovalRecord {
  const rec: ApprovalRecord = {
    n: (state?.records ?? 0) + 1,
    at,
    base: prevText === undefined ? null : sha256(prevText),
    alfredish: alfredish.approve ? alfredish.now : (state?.last?.alfredish ?? null),
    pinned: alfredish.approve ? (alfredish.pinned ?? null) : (state?.last?.pinned ?? null),
    approved: {},
    removed: [],
    rejected: {},
    corrections: {},
  };
  for (const c of changes) {
    const d = decisions.get(c.id);
    if (!d || d.kind === "skip") continue;
    const now = snap[c.id];
    if (c.op === "-") {
      if (d.kind === "approve") rec.removed.push(c.id);
      continue;
    }
    if (!now) continue;
    if (d.kind === "approve") rec.approved[c.id] = { kind: now.kind, hash: now.hash, data: now.data };
    if (d.kind === "correct") rec.corrections[c.id] = { hash: now.hash, note: d.note };
    if (d.kind === "reject") rec.rejected[c.id] = d.note === undefined ? { hash: now.hash } : { hash: now.hash, note: d.note };
  }
  return rec;
}

/**
 * Writes the record and signs it with a key from the anchor list (its private half in the ssh-agent at `agentSocket`,
 * e.g. a Secure Enclave key). If no listed key can sign on this machine, nothing is recorded.
 */
export async function writeSigned(base: string, rec: ApprovalRecord, anchorPath: string, agentSocket?: string, privateKey?: string): Promise<{ ok: boolean; message: string }> {
  await mkdir(join(base, APPROVALS_DIR), { recursive: true });
  const file = join(base, APPROVALS_DIR, recordName(rec.n));
  await writeFile(file, JSON.stringify(rec, null, 1));
  const tries: string[] = [];
  if (privateKey) tries.push(privateKey);
  else {
    for (const [i, key] of (await readAnchor(anchorPath)).entries()) {
      const pub = join(tmpdir(), `alfredish-anchor-${process.pid}-${i}.pub`);
      await writeFile(pub, key + "\n");
      tries.push(pub);
    }
  }
  for (const k of tries) {
    const r = await signFile(file, k, privateKey ? undefined : agentSocket);
    if (r.ok) return { ok: true, message: `approval ${rec.n} signed` };
  }
  await rm(file, { force: true });
  await rm(`${file}.sig`, { force: true });
  return { ok: false, message: "no owner key on this machine could sign — nothing recorded" };
}

const SYMBOL: Record<Op, string> = { "+": "new", "~": "changed", "-": "removed" };

/**
 * What the owner needs to judge a new copy of Alfredish: which commit it claims to be, whether its files are exactly
 * that commit's files in the Alfredish source this tool was installed from, and the commits since the last approved one.
 */
const COPY = {
  last: (p: string) => ` (approved last time: ${p})`, cannot: "? the copy cannot be compared with Alfredish's source on this machine",
  same: (p: string) => `✓ the copy is exactly the files of Alfredish ${p}`, differs: (p: string) => `✗ the copy is NOT the files of Alfredish ${p}: do not approve it`,
  since: "changes since then:", latest: "latest changes (the last approved commit is not known):",
} as const;

export async function alfredishCopyInfo(base: string, previous: string | null | undefined, source?: string): Promise<{ lines: string[]; pinned: string | null }> {
  const w = COPY;
  const vendor = join(base, "vendor", "alfredish");
  const pinned = (await readFile(join(vendor, "PINNED"), "utf8").catch(() => "")).trim() || null;
  const lines = [`Alfredish ${pinned ?? "?"}${previous ? w.last(previous) : ""}`];
  if (!source || !pinned || !/^[0-9a-f]{4,40}$/.test(pinned)) {
    lines.push(w.cannot);
    return { lines, pinned };
  }
  const git = (...a: string[]) => run("git", ["-C", source, ...a]);
  const tmp = await mkdtemp(join(tmpdir(), "alfredish-copy-"));
  try {
    const tar = join(tmp, "copy.tar");
    const archived = await git("archive", "-o", tar, pinned, "--", "src", "SPEC.md", "package.json", "models");
    const tree = join(tmp, "tree");
    await mkdir(tree);
    const extracted = archived.code === 0 && (await run("tar", ["-xf", tar, "-C", tree])).code === 0;
    if (extracted) await writeFile(join(tree, "PINNED"), await readFile(join(vendor, "PINNED")));
    const same = extracted && (await hashTree(tree)) === (await hashTree(vendor));
    lines.push(same ? w.same(pinned) : w.differs(pinned));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const log = await git("log", "--format=%h %s", "-n", previous ? "30" : "5", previous ? `${previous}..${pinned}` : pinned);
  if (log.code === 0 && log.out.trim()) lines.push("", previous ? w.since : w.latest, ...log.out.trim().split("\n").map((l) => `  · ${l}`));
  return { lines, pinned };
}

/** Where this copy of Alfredish was installed from (written by scripts/install-approve.sh). */
async function installedFrom(): Promise<string | undefined> {
  const text = await readFile(fileURLToPath(new URL("../SOURCE", import.meta.url)), "utf8").catch(() => "");
  return text.trim() || undefined;
}

/** The terminal dialogue (run by the owner): the arrow-key screen in a terminal, plain questions otherwise. */
export async function approveInteractive(o: { base: string; snap: Snapshot; state: ApprovedState | undefined; anchorPath: string; agentSocket?: string; today: ISODate }): Promise<number> {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const changes = changesSince(o.state, o.snap, tty && !process.env["NO_COLOR"] ? COLOURS : PLAIN);
  const vendor = await hashTree(join(o.base, "vendor", "alfredish"));
  const vendorChanged = vendor !== null && vendor !== (o.state?.last?.alfredish ?? null);
  if (!changes.length && !vendorChanged) {
    console.log("Nothing changed since your last approval.");
    return 0;
  }
  const copy = vendorChanged ? await alfredishCopyInfo(o.base, o.state?.last?.pinned, await installedFrom()) : undefined;
  const firstRound = !o.state?.records;
  const answers = tty ? await askOnScreen(changes, copy?.lines, firstRound) : await askByLines(changes, copy?.lines, firstRound);
  if (!answers) {
    console.log("Quit: nothing recorded.");
    return 0;
  }
  const { decisions, approveVendor } = answers;
  const counted = [...decisions.values()].filter((d) => d.kind !== "skip").length;
  if (!counted && !approveVendor) {
    console.log("Nothing decided — nothing recorded.");
    return 0;
  }
  const prev = o.state?.records ? await readFile(join(o.base, APPROVALS_DIR, recordName(o.state.records)), "utf8") : undefined;
  const rec = buildRecord(o.state, o.snap, changes, decisions, o.today, { now: vendor, approve: approveVendor, pinned: copy?.pinned ?? null }, prev);
  console.log("Signing — give your fingerprint only if the prompt names your terminal, not another program.");
  const r = await writeSigned(o.base, rec, o.anchorPath, o.agentSocket);
  console.log(r.message);
  return r.ok ? 0 : 1;
}

type Answers = { decisions: Map<string, Decision>; approveVendor: boolean } | undefined;

/** The arrow-key screen. Undefined when the owner quits. */
async function askOnScreen(changes: Change[], vendorLines: string[] | undefined, firstRound: boolean): Promise<Answers> {
  const screen = newScreen(entriesFor(changes, { firstRound, ...(vendorLines && { vendor: vendorLines }) }));
  const out = process.stdout;
  const draw = () => out.write(`\x1b[H\x1b[2J${render(screen)}`);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  out.write("\x1b[?1049h\x1b[?25l");
  draw();
  await new Promise<void>((done) => {
    const onKey = (_: string, key: Key | undefined) => {
      step(screen, key ?? {});
      if (screen.mode === "signed" || screen.mode === "quit") {
        process.stdin.off("keypress", onKey);
        done();
      } else draw();
    };
    process.stdin.on("keypress", onKey);
  });
  process.stdin.setRawMode(false);
  process.stdin.pause();
  out.write("\x1b[?25h\x1b[?1049l");
  if (screen.mode === "quit") return undefined;
  const decisions = new Map(screen.decisions);
  const approveVendor = decisions.get(VENDOR_KEY)?.kind === "approve";
  decisions.delete(VENDOR_KEY);
  return { decisions, approveVendor };
}

/** Plain questions, one per line, for input that is not a terminal. */
async function askByLines(changes: Change[], vendorLines: string[] | undefined, firstRound: boolean): Promise<Answers> {
  // Lines are queued as they arrive, so answers typed ahead (or pasted at once) are never lost.
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiting.shift();
    if (w) w(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift()!("");
  });
  const ask = async (q: string) => {
    process.stdout.write(q);
    const line = queued.length ? queued.shift()! : closed ? "" : await new Promise<string>((r) => waiting.push(r));
    return line.trim();
  };
  const decisions = new Map<string, Decision>();
  let approveVendor = false;
  console.log(`${changes.length} change${changes.length === 1 ? "" : "s"} to decide.\n`);
  if (vendorLines) {
    console.log(`! The memory's copy of Alfredish changed (vendor/alfredish):\n${vendorLines.map((l) => `    ${l}`).join("\n")}`);
    approveVendor = (await ask("  approve the new Alfredish copy? [y/N] ")).toLowerCase() === "y";
  }
  if (firstRound) {
    console.log(`This is your first approval: ${changes.length} definitions make up the memory today.`);
    if ((await ask("  approve the memory as it is as your starting point? [y/N] ")).toLowerCase() === "y") {
      for (const c of changes) decisions.set(c.id, { kind: "approve" });
      approveVendor = vendorLines !== undefined;
    }
  }
  const pending = changes.filter((c) => !decisions.has(c.id));
  const owner = pending.filter((c) => c.group === "owner");
  const machine = pending.filter((c) => c.group === "machine");
  if (owner.length) console.log("\n— Your calls —");
  for (const c of owner) {
    if (c.note) console.log(`  (your note last time: ${c.note})`);
    const why = c.why ?? (c.kind === "session" ? "the session record: its topic, questions and the reasons above" : "(no reason given)");
    console.log(`\n${c.op} ${c.id}  [${c.kind}, ${SYMBOL[c.op]}]\n    why: ${why}\n${c.shown.map((l) => `    ${l}`).join("\n")}`);
    const a = (await ask(c.op === "-" ? "  [a]pprove removal, [s]kip: " : "  [a]pprove, [c]orrect, [r]eject, [s]kip: ")).toLowerCase();
    if (a === "a") decisions.set(c.id, { kind: "approve" });
    else if (a === "c" && c.op !== "-") decisions.set(c.id, { kind: "correct", note: await ask("    note for the agent: ") });
    else if (a === "r" && c.op !== "-") {
      const note = await ask("    why (optional): ");
      decisions.set(c.id, note ? { kind: "reject", note } : { kind: "reject" });
    } else decisions.set(c.id, { kind: "skip" });
  }
  if (machine.length) {
    console.log("\n— Machine-checked (each shown with its test) —");
    for (const c of machine) console.log(`\n${c.op} ${c.id}${c.why ? `\n    why: ${c.why}` : ""}\n${c.shown.map((l) => `    ${l}`).join("\n")}\n    test: ${c.test}`);
    const all = (await ask(`  approve all ${machine.length}? [y]es, [o]ne by one, [n]o: `)).toLowerCase();
    for (const c of machine) {
      if (all === "y") decisions.set(c.id, { kind: "approve" });
      else if (all === "o") decisions.set(c.id, (await ask(`  ${c.id}: [a]pprove, [s]kip: `)).toLowerCase() === "a" ? { kind: "approve" } : { kind: "skip" });
    }
  }
  rl.close();
  return { decisions, approveVendor };
}
