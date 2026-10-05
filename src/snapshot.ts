// Stable serialization of definitions. Used for K5 (past is immutable) and `alfred diff`.
import { createHash } from "node:crypto";
import { isDef } from "./compiler.ts";
import type { Def, Verify } from "./types.ts";

export type Snapshot = Record<string, { kind: string; hash: string; data: Record<string, unknown> }>;

const VERIFY_KINDS = new Set(["probe", "agentProbe", "source", "fromFinding", "review", "confirm", "after", "derived", "linked"]);

export function describeVerify(v: Verify): string {
  switch (v.kind) {
    case "probe":
      return v.describe;
    case "agentProbe":
      return `agent: ${v.describe} (ttl ${v.ttl}${v.last ? `, last ${v.last.at} ${v.last.ok ? "ok" : "failed"}` : ""})`;
    case "source":
      return `source ${v.url} (read ${v.readAt}, ttl ${v.ttl})`;
    case "linked":
      return `linked to ${v.memory}:${v.target} (${v.targetKind}, signed ${v.hash.slice(0, 16)}, evidence ${v.evidence})`;
    case "fromFinding":
      return `finding ${v.finding.research?.id ?? "?"}#${v.finding.key} (ttl ${v.ttl})`;
    case "review":
      return `review by ${v.by} ${v.at} (every ${v.every})`;
    case "confirm":
      return v.at ? `confirmed by ${v.by} ${v.at}${v.what ? `: ${v.what}` : ""}` : v.what ? `when ${v.by} confirms: ${v.what}` : `waiting for ${v.by} to confirm`;
    case "after":
      return `after ${v.date}`;
    case "derived":
      return `derived [${v.from.map((d) => d.id).join(", ")}]`;
  }
}

function plain(x: unknown, depth: number): unknown {
  if (x === null || typeof x !== "object") return typeof x === "function" ? undefined : x;
  if (depth > 0 && isDef(x)) return `@${x.id}`;
  // A retired definition named in a past event serialises like the live reference did, so the event is unchanged (K5).
  if (depth > 0 && (x as { kind?: unknown }).kind === "retired" && typeof (x as { id?: unknown }).id === "string") return `@${(x as { id: string }).id}`;
  if (Array.isArray(x)) return x.map((v) => plain(v, depth + 1));
  if ("kind" in x && VERIFY_KINDS.has(String((x as { kind: unknown }).kind)) && !isDef(x)) {
    return describeVerify(x as Verify);
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x).sort()) {
    if (k === "research") continue; // back-reference from a finding
    const v = plain((x as Record<string, unknown>)[k], depth + 1);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function serialize(d: Def): Record<string, unknown> {
  return plain(d, 0) as Record<string, unknown>;
}

export function hashOf(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
}

export function snapshot(defs: readonly Def[]): Snapshot {
  const out: Snapshot = {};
  for (const d of [...defs].sort((a, b) => a.id.localeCompare(b.id))) {
    const data = serialize(d);
    out[d.id] = { kind: d.kind, hash: hashOf(data), data };
  }
  return out;
}

export interface DiffLine {
  op: "+" | "-" | "~";
  id: string;
  kind: string;
  detail: string;
}

export function diffSnapshots(a: Snapshot, b: Snapshot): DiffLine[] {
  const lines: DiffLine[] = [];
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const id of ids) {
    const x = a[id];
    const y = b[id];
    if (!x && y) lines.push({ op: "+", id, kind: y.kind, detail: String(y.data["title"] ?? "") });
    else if (x && !y) lines.push({ op: "-", id, kind: x.kind, detail: String(x.data["title"] ?? "") });
    else if (x && y && x.hash !== y.hash) {
      const changed = [...new Set([...Object.keys(x.data), ...Object.keys(y.data)])]
        .filter((k) => JSON.stringify(x.data[k]) !== JSON.stringify(y.data[k]))
        .map((k) => `${k}: ${short(x.data[k])} → ${short(y.data[k])}`);
      lines.push({ op: "~", id, kind: y.kind, detail: changed.join(" · ") });
    }
  }
  return lines;
}

function short(v: unknown): string {
  const s = v === undefined ? "∅" : typeof v === "string" ? `"${v}"` : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
