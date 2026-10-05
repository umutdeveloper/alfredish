// SPEC §14: what the owner's signed approvals mean for a check — K26 (unapproved content) and K28 (the signed state is
// the reference, and the memory's copy of Alfredish is part of it).

import { deps, type Issue } from "./compiler.ts";
import { relative } from "node:path";
import { hashTree, loadApprovals, sharedCopyRoot, vendorDir, type ApprovedState } from "./approval.ts";
import { confirmedPaths } from "./paths.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Def } from "./types.ts";

/**
 * The agent's side of owner approval, written by Alfredish into AGENTS.md of every memory that has approvals/ — the
 * same in every memory, so no memory has to restate it (and none can weaken it).
 */
export const APPROVAL_PROTOCOL: readonly string[] = [
  "This memory has owner approval (Alfredish §14): nothing you add or change counts as approved until the owner signs that exact content.",
  "Give every definition you add, change or remove a one-line reason in today's session: `changes: { \"<id>\": \"<why>\" }`. A change without a reason is red.",
  "Never approve for the owner: do not run `alfred approve` or `alfred-approve`, do not answer its questions, do not ask the owner for a fingerprint, and never write in approvals/. Change vendor/alfredish only by copying a committed Alfredish version the owner asked for; the copy waits for the owner's approval (K28).",
  "When the check shows unapproved changes, tell the owner how many and why, and ask them to run `alfred-approve` in this folder in their own terminal (not one you started); then check again.",
  "When the check shows an owner's correction note, rewrite that definition as the note says and give the reason; the new version goes back to the owner. A rejected definition goes back to its approved content.",
];

/** K28: the approved state as a snapshot, to compare with instead of HEAD. */
export function referenceSnapshot(state: ApprovedState): Snapshot {
  const out: Snapshot = {};
  for (const [id, it] of state.items) out[id] = { kind: it.kind, hash: it.hash, data: it.data };
  return out;
}

const OWNER_VERIFY = /^(review by owner|confirmed by owner|when owner confirms|waiting for owner)/;
const isLocal = (x: unknown) => typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "local";

/**
 * The latest session reason for each changed id (sessions carry `changes`, §14): sessions by day, and within a day a
 * session the owner signed and that is unchanged before one that is new or changed. `twice` names the ids two new or
 * changed sessions of one day give a reason for — the order between them is unknown, so the owner could read a stale one.
 */
export function latestReasons(snap: Snapshot, state?: ApprovedState): { why: Map<string, string>; twice: Map<string, { at: string; sessions: string[] }> } {
  const fresh = (id: string) => state?.items.get(id)?.hash !== snap[id]!.hash;
  const sessions = Object.entries(snap).filter(([, e]) => e.kind === "session")
    .sort(([a, x], [b, y]) => String(x.data["at"]).localeCompare(String(y.data["at"])) || Number(fresh(a)) - Number(fresh(b)) || a.localeCompare(b));
  const why = new Map<string, string>();
  const by = new Map<string, { at: string; sessions: string[] }>();
  for (const [sid, s] of sessions) {
    const at = String(s.data["at"]);
    for (const [id, w] of Object.entries((s.data["changes"] as Record<string, string> | undefined) ?? {})) {
      why.set(id, w);
      if (!fresh(sid)) continue;
      const seen = by.get(id);
      by.set(id, seen && seen.at === at ? { at, sessions: [...seen.sessions, sid] } : { at, sessions: [sid] });
    }
  }
  return { why, twice: new Map([...by].filter(([, v]) => v.sessions.length > 1)) };
}

/**
 * K26: content that differs from what the owner last signed is unapproved — yellow, with its reason — and so is what
 * rests on it. A review, confirmation or local() path the owner has not signed counts as not given (red), as does a
 * rejected definition not yet restored, and (once a first record exists) a change without a reason.
 */
export function checkApproval(snap: Snapshot, defs: readonly Def[], state: ApprovedState): Issue[] {
  const issues: Issue[] = [];
  const { why, twice } = latestReasons(snap, state);
  const unapproved = new Set<string>();
  const byId = new Map(defs.map((d) => [d.id, d]));
  for (const [id, now] of Object.entries(snap)) {
    const was = state.items.get(id);
    if (was && was.hash === now.hash) continue;
    unapproved.add(id);
    if (now.kind === "session") continue; // a session is the container of the reasons, approved with them
    const red = (message: string) => issues.push({ id, status: "red", rule: "K26", message });
    const rejected = state.rejected.get(id);
    if (rejected && rejected.hash === now.hash) {
      red(`rejected by the owner${rejected.note ? ` ("${rejected.note}")` : ""} — restore the approved version`);
      continue;
    }
    const verify = String(now.data["verify"] ?? "");
    if (OWNER_VERIFY.test(verify) && verify !== String(was?.data["verify"] ?? "")) {
      red(`"${verify}" is not signed by the owner — it counts only after alfred approve`);
      continue;
    }
    const where = now.data["location"] ?? now.data["where"];
    if (isLocal(where) && JSON.stringify(where) !== JSON.stringify(was?.data["location"] ?? was?.data["where"])) {
      red("a local() path the owner has not signed — it counts only after alfred approve");
      continue;
    }
    // The same for a local() path inside a test (file(local(...))): its record keeps only the test's description.
    const tests = (x: typeof now | undefined) => `${String(x?.data["verify"] ?? "")}\n${String(x?.data["due"] ?? "")}`;
    const d = byId.get(id);
    if (d && [...confirmedPaths([d])].some((p) => tests(now).includes(p) && !tests(was).includes(p))) {
      red("a local() path the owner has not signed (in its test) — it counts only after alfred approve");
      continue;
    }
    const two = twice.get(id);
    if (two) {
      red(`two of ${two.at}'s sessions not yet signed give a reason (${two.sessions.join(", ")}) — keep it in one, so the owner reads the right one`);
      continue;
    }
    const correction = state.corrections.get(id);
    if (correction && correction.hash === now.hash) {
      issues.push({ id, status: "yellow", rule: "K26", message: `the owner asked for a correction: "${correction.note}" — rewrite it as the note says` });
      continue;
    }
    if (state.records > 0 && !why.has(id)) {
      red(`changed since approval ${state.records} without a reason — add "${id}": "<why>" to the session's changes`);
      continue;
    }
    issues.push({ id, status: "yellow", rule: "K26", message: `unapproved${why.has(id) ? `: ${why.get(id)}` : ""} — the owner sees it in alfred approve` });
  }
  // Resting on unapproved content makes a definition unapproved too (K3).
  const flagged = new Set(issues.map((i) => i.id));
  const memo = new Map<string, string | undefined>();
  const restsOnUnapproved = (d: Def, seen = new Set<Def>()): string | undefined => {
    if (memo.has(d.id)) return memo.get(d.id);
    if (seen.has(d)) return undefined;
    seen.add(d);
    let found: string | undefined;
    for (const x of deps(d)) {
      if (unapproved.has(x.id) && x.kind !== "session") found = x.id;
      else found = restsOnUnapproved(x, seen);
      if (found) break;
    }
    memo.set(d.id, found);
    return found;
  };
  for (const d of defs) {
    if (flagged.has(d.id) || !byId.has(d.id)) continue;
    const on = restsOnUnapproved(d);
    if (on) issues.push({ id: d.id, status: "yellow", rule: "K26", message: `rests on unapproved ${on}` });
  }
  return issues;
}

/** K28: the memory's copy of Alfredish must be the one the owner last signed. */
export async function checkAlfredishCopy(base: string, state: ApprovedState, anchor: string): Promise<Issue[]> {
  // A shared copy is approved once for the whole repository of memories (§9.3); until a first such record exists, the
  // memory's own last record still says which copy was approved.
  const root = sharedCopyRoot(base);
  const repo = root ? await loadApprovals(root, anchor) : undefined;
  const issues: Issue[] = (repo?.issues ?? []).map((i) => ({ ...i, id: `${relative(base, root!)}/${i.id}` }));
  const shared = repo?.state && repo.state.records > 0 ? repo.state.last : undefined;
  const signed = shared ? shared.alfredish : state.last?.alfredish;
  if (!signed) return issues;
  const now = await hashTree(vendorDir(base));
  if (now !== signed) issues.push({ id: "vendor/alfredish", status: "red", rule: "K28", message: `the copy of Alfredish changed since the owner's last approval${shared ? " for this repository of memories" : ""} — it counts only after alfred approve` });
  return issues;
}
