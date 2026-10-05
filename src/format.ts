// Token-cheap output (SPEC §9): one line when everything is green, only problems otherwise.
import type { Report } from "./compiler.ts";
import { deps, isPresent } from "./compiler.ts";
import { describeVerify } from "./snapshot.ts";
import type { Def, Location, Status } from "./types.ts";

export const MARK: Record<Status, string> = { green: "✓", yellow: "!", red: "✗", unknown: "?" };

export function formatCheck(r: Report): string {
  const { definitions, tests, parked } = r.counts;
  const tail = `${definitions} definitions · ${tests} tests · 100% · ${parked} parked`;
  if (r.issues.length === 0) return `✓ ${tail}`;
  const lines = r.issues.map((i) => `${MARK[i.status]} ${i.id} — ${i.rule === "status" ? "" : i.rule + ": "}${i.message}`);
  const n = (s: Status) => r.issues.filter((i) => i.status === s).length;
  lines.push(`${n("red") ? "✗" : "!"} ${n("red")} red · ${n("yellow")} yellow · ${n("unknown")} unknown · ${tail}`);
  return lines.join("\n");
}

export function valueOf(d: Def): string {
  switch (d.kind) {
    case "fact":
      return String(d.value);
    case "claim":
    case "rule":
    case "idea":
      return d.text;
    case "asset":
      return `${d.desired} @ ${showLocation(d.location)}`;
    case "account":
      return `${d.service} · ${d.login} · agent access: ${d.agentAccess}`;
    case "promise":
      return `${d.owner} · due ${typeof d.due === "string" ? d.due : `when ${describeVerify(d.due)}`}`;
    case "goal":
      return `${d.phase.name} (ends ${d.phase.ends})`;
    case "decision":
      return d.title;
    case "event":
      return d.text;
    case "research":
      return d.question;
    case "session":
      return d.topic;
    case "key":
      return `${d.valueType} · ${d.describe}`;
    case "link":
      return `${d.memory}:${d.target}`;
  }
}

export function formatGet(r: Report, id: string): string {
  const res = r.results.get(id);
  if (!res) return `? ${id} — no such definition`;
  const d = res.def;
  const lines = [`${MARK[res.status]} ${id} = ${valueOf(d)}`];
  if (res.status !== "green") lines.push(`  ${res.status === "red" ? "DO NOT USE — " : ""}${res.reasons.join(" · ")}`);
  if (isPresent(d)) lines.push(`  evidence: ${d.evidence} · verify: ${describeVerify(d.verify)}`);
  if (d.kind !== "session") lines.push(`  origin: ${d.origin.at} "${d.origin.topic}"`);
  return lines.join("\n");
}

export function formatWhy(r: Report, id: string): string {
  const res = r.results.get(id);
  if (!res) return `? ${id} — no such definition`;
  const d = res.def;
  const mark = (x: Def) => MARK[r.results.get(x.id)?.status ?? "unknown"];
  const lines = [`${MARK[res.status]} ${id} — ${d.title}`];
  if (d.kind !== "session") lines.push(`  why it exists: ${d.origin.at} "${d.origin.topic}"`);
  for (const u of deps(d)) lines.push(`  rests on → ${mark(u)} ${u.id}`);
  for (const other of r.results.values()) if (deps(other.def).includes(d)) lines.push(`  supports ← ${MARK[other.status]} ${other.def.id}`);
  return lines.join("\n");
}

export const showLocation = (l: Location): string => (l.kind === "url" ? l.href : `local:${l.path}`);
