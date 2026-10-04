// SPEC §14 `alfred approve`: the owner's approval round. The core (what changed, the record a set of decisions makes)
// is plain functions so it can be tested with throwaway keys; the terminal dialogue is a thin layer on top.
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APPROVALS_DIR, hashTree, readAnchor, recordName, sha256, signFile, type ApprovalRecord, type ApprovedState } from "./approval.ts";
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

const CONTEXT_WORDS = 6;
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** One changed text: the unchanged words around it as context, then the removed and the added words in full. */
export function textChange(before: string, after: string): string[] {
  const a = before.split(" ");
  const b = after.split(" ");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const head = a.slice(Math.max(0, p - CONTEXT_WORDS), p).join(" ");
  const tail = a.slice(a.length - s, a.length - s + CONTEXT_WORDS).join(" ");
  const out: string[] = [];
  if (head) out.push(`${p > CONTEXT_WORDS ? "…" : ""}${head}`);
  const gone = a.slice(p, a.length - s).join(" ");
  const added = b.slice(p, b.length - s).join(" ");
  if (gone) out.push(`− ${gone}`);
  if (added) out.push(`+ ${added}`);
  if (tail) out.push(`${tail}${s > CONTEXT_WORDS ? "…" : ""}`);
  return out;
}

function shownFor(op: Op, was: Record<string, unknown> | undefined, now: Record<string, unknown> | undefined): string[] {
  if (op !== "~") {
    const data = (op === "+" ? now : was) ?? {};
    return Object.entries(data).filter(([k]) => k !== "id").map(([k, v]) => `${k}: ${show(v)}`);
  }
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})])].sort()) {
    const x = was?.[k];
    const y = now?.[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    out.push(`${k}:`);
    if (typeof x === "string" && typeof y === "string") out.push(...textChange(x, y).map((l) => `  ${l}`));
    else {
      if (x !== undefined) out.push(`  − ${show(x)}`);
      if (y !== undefined) out.push(`  + ${show(y)}`);
    }
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
export function changesSince(state: ApprovedState | undefined, snap: Snapshot): Change[] {
  const approved: Snapshot = {};
  for (const [id, it] of state?.items ?? []) approved[id] = { kind: it.kind, hash: it.hash, data: it.data };
  const why = reasons(snap);
  const out: Change[] = diffSnapshots(approved, snap).map((d) => {
    const data = snap[d.id]?.data;
    const c: Change = { id: d.id, op: d.op, kind: d.kind, group: groupOf(d.op, d.kind, data), detail: d.detail, shown: shownFor(d.op, approved[d.id]?.data, data) };
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
export function buildRecord(state: ApprovedState | undefined, snap: Snapshot, changes: readonly Change[], decisions: ReadonlyMap<string, Decision>, at: ISODate, alfredish: { now: string | null; approve: boolean }, prevText?: string): ApprovalRecord {
  const rec: ApprovalRecord = {
    n: (state?.records ?? 0) + 1,
    at,
    base: prevText === undefined ? null : sha256(prevText),
    alfredish: alfredish.approve ? alfredish.now : (state?.last?.alfredish ?? null),
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

/** The terminal dialogue (run by the owner). */
export async function approveInteractive(o: { base: string; snap: Snapshot; state: ApprovedState | undefined; anchorPath: string; agentSocket?: string; today: ISODate }): Promise<number> {
  const changes = changesSince(o.state, o.snap);
  const vendor = await hashTree(join(o.base, "vendor", "alfredish"));
  const vendorChanged = vendor !== null && vendor !== (o.state?.last?.alfredish ?? null);
  if (!changes.length && !vendorChanged) {
    console.log("Nothing changed since your last approval.");
    return 0;
  }
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
  console.log(`${changes.length} change${changes.length === 1 ? "" : "s"} since approval ${o.state?.records ?? 0}.\n`);
  if (vendorChanged) {
    console.log("! The memory's copy of Alfredish changed (vendor/alfredish). Approve it only if you updated Alfredish yourself.");
    approveVendor = (await ask("  approve the new Alfredish copy? [y/N] ")).toLowerCase() === "y";
  }
  if (!o.state?.records) {
    console.log(`This is your first approval: ${changes.length} definitions make up the memory today.`);
    if ((await ask("  approve the memory as it is as your starting point? [y/N] ")).toLowerCase() === "y") {
      for (const c of changes) decisions.set(c.id, { kind: "approve" });
      approveVendor = vendor !== null;
    }
  }
  const pending = changes.filter((c) => !decisions.has(c.id));
  const owner = pending.filter((c) => c.group === "owner");
  const machine = pending.filter((c) => c.group === "machine");
  if (owner.length) console.log("\n— Your calls —");
  for (const c of owner) {
    if (c.note) console.log(`  (your note last time: ${c.note})`);
    const why = c.why ?? (c.kind === "session" ? "the session record: its topic, questions and the reasons above" : "(no reason given)");
    console.log(`${c.op} ${c.id}  [${c.kind}, ${SYMBOL[c.op]}]\n${c.shown.map((l) => `    ${l}`).join("\n")}\n    why: ${why}`);
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
    for (const c of machine) console.log(`${c.op} ${c.id}\n${c.shown.map((l) => `    ${l}`).join("\n")}\n    test: ${c.test}${c.why ? `\n    why: ${c.why}` : ""}`);
    const all = (await ask(`  approve all ${machine.length}? [y]es, [o]ne by one, [n]o: `)).toLowerCase();
    for (const c of machine) {
      if (all === "y") decisions.set(c.id, { kind: "approve" });
      else if (all === "o") decisions.set(c.id, (await ask(`  ${c.id}: [a]pprove, [s]kip: `)).toLowerCase() === "a" ? { kind: "approve" } : { kind: "skip" });
    }
  }
  rl.close();
  const counted = [...decisions.values()].filter((d) => d.kind !== "skip").length;
  if (!counted && !approveVendor) {
    console.log("\nNothing decided — nothing recorded.");
    return 0;
  }
  const prev = o.state?.records ? await readFile(join(o.base, APPROVALS_DIR, recordName(o.state.records)), "utf8") : undefined;
  const rec = buildRecord(o.state, o.snap, changes, decisions, o.today, { now: vendor, approve: approveVendor }, prev);
  console.log("\nSigning — give your fingerprint only if the prompt names your terminal, not another program.");
  const r = await writeSigned(o.base, rec, o.anchorPath, o.agentSocket);
  console.log(r.message);
  return r.ok ? 0 : 1;
}
