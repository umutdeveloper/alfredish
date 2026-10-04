// SPEC §14: what the owner's signed approvals mean for a check — K26 (unapproved content) and K28 (the signed state is
// the reference, and the memory's copy of Alfredish is part of it).
import { join } from "node:path";
import { deps, type Issue } from "./compiler.ts";
import { hashTree, type ApprovedState } from "./approval.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Def } from "./types.ts";

/** K28: the approved state as a snapshot, to compare with instead of HEAD. */
export function referenceSnapshot(state: ApprovedState): Snapshot {
  const out: Snapshot = {};
  for (const [id, it] of state.items) out[id] = { kind: it.kind, hash: it.hash, data: it.data };
  return out;
}

const OWNER_VERIFY = /^(review by owner|confirmed by owner|when owner confirms|waiting for owner)/;
const isLocal = (x: unknown) => typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "local";

/** The latest session reason for each changed id (sessions carry `changes`, §14). */
function reasons(snap: Snapshot): Map<string, string> {
  const sessions = Object.values(snap).filter((e) => e.kind === "session").sort((a, b) => String(a.data["at"]).localeCompare(String(b.data["at"])));
  const out = new Map<string, string>();
  for (const s of sessions) for (const [id, why] of Object.entries((s.data["changes"] as Record<string, string> | undefined) ?? {})) out.set(id, why);
  return out;
}

/**
 * K26: content that differs from what the owner last signed is unapproved — yellow, with its reason — and so is what
 * rests on it. A review, confirmation or local() path the owner has not signed counts as not given (red), as does a
 * rejected definition not yet restored, and (once a first record exists) a change without a reason.
 */
export function checkApproval(snap: Snapshot, defs: readonly Def[], state: ApprovedState): Issue[] {
  const issues: Issue[] = [];
  const why = reasons(snap);
  const unapproved = new Set<string>();
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
    if (state.records > 0 && !why.has(id)) {
      red(`changed since approval ${state.records} without a reason — add "${id}": "<why>" to the session's changes`);
      continue;
    }
    issues.push({ id, status: "yellow", rule: "K26", message: `unapproved${why.has(id) ? `: ${why.get(id)}` : ""} — the owner sees it in alfred approve` });
  }
  // Resting on unapproved content makes a definition unapproved too (K3).
  const byId = new Map(defs.map((d) => [d.id, d]));
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
export async function checkAlfredishCopy(base: string, state: ApprovedState): Promise<Issue[]> {
  const signed = state.last?.alfredish;
  if (!signed) return [];
  const now = await hashTree(join(base, "vendor", "alfredish"));
  return now === signed ? [] : [{ id: "vendor/alfredish", status: "red", rule: "K28", message: "the copy of Alfredish changed since the owner's last approval — it counts only after alfred approve" }];
}
