// K6: human-readable views are generated from definitions, never written by hand.
import { createHash } from "node:crypto";
import type { Report } from "./compiler.ts";
import { MARK, valueOf } from "./format.ts";
import { APPROVAL_PROTOCOL } from "./owner.ts";
import { describeVerify } from "./snapshot.ts";
import type { Def, DecisionDef, FactDef, Finding, ISODate, ResearchDef, SessionDef } from "./types.ts";

const HEADER = "<!-- alfredish: generated, do not edit — run `alfred build`";

export interface View {
  path: string;
  body: string;
  /** Deterministic views are also checked for staleness; NOW.md depends on time, so only for hand edits. */
  deterministic: boolean;
}

export const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);
export const render = (v: View) => `${HEADER} · body:${bodyHash(v.body)} -->\n${v.body}`;

/** Splits a generated file into its recorded hash and body. undefined = not a generated file. */
export function parseGenerated(text: string): { hash: string; body: string } | undefined {
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  const m = /body:([0-9a-f]{16}) -->$/.exec(first);
  if (!first.startsWith(HEADER) || !m) return undefined;
  return { hash: m[1]!, body: nl < 0 ? "" : text.slice(nl + 1) };
}

const SECTIONS: [Def["kind"], string][] = [
  ["decision", "Decisions"],
  ["promise", "Promises"],
  ["goal", "Goals"],
  ["idea", "Ideas"],
  ["claim", "Public claims"],
  ["fact", "Facts"],
  ["account", "Accounts"],
  ["asset", "Assets"],
  ["link", "Links to other memories"],
  ["rule", "Rules"],
  ["research", "Research"],
  ["event", "Events"],
];

const byId = <T extends Def>(a: T, b: T) => a.id.localeCompare(b.id);
const code = (id: string) => `\`${id}\``;
const list = (items: string[]) => (items.length ? items.join("\n") : "- none");

/** `approval`: the memory has owner approval (§14), so AGENTS.md starts with Alfredish's approval protocol. */
export function buildViews(defs: readonly Def[], report: Report, today: ISODate, o: { approval?: boolean } = {}): View[] {
  const views: View[] = [];
  const of = <K extends Def["kind"]>(k: K) => defs.filter((d): d is Extract<Def, { kind: K }> => d.kind === k).sort(byId);
  const sessions = of("session").sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const decisions = of("decision");
  const superseded = new Set(decisions.flatMap((d) => (d.supersedes ? [d.supersedes] : [])));
  const facts = of("fact");
  const researches = of("research").sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const born = (d: Def) => (d.kind === "session" ? "" : ` · born ${d.origin.at} "${d.origin.topic}"`);
  const mark = (d: Def) => MARK[report.results.get(d.id)?.status ?? "unknown"];
  const state = (d: Def) => `${mark(d)} ${report.results.get(d.id)?.done ? "done" : "open"}`;
  const det = (path: string, body: string) => views.push({ path, body, deterministic: true });

  // decisions.md
  {
    const fmt = (d: DecisionDef) =>
      `- **${d.title}** (${code(d.id)}) — rests on: ${d.restsOn.map((r) => code(r.id)).join(", ") || "nothing"} · re-approve every ${d.review}${born(d)}`;
    const cur = decisions.filter((d) => !superseded.has(d));
    const old = decisions.filter((d) => superseded.has(d));
    const by = (o: DecisionDef) => decisions.find((d) => d.supersedes === o)!.id;
    det("decisions.md", `# Decisions\n\n## Current\n${list(cur.map(fmt))}\n` + (old.length ? `\n## Superseded\n${old.map((o) => `${fmt(o)} → ${code(by(o))}`).join("\n")}\n` : ""));
  }

  // promises.md
  {
    const ps = of("promise");
    const sec = (owner: "owner" | "agent", title: string) =>
      `## ${title}\n${list(
        ps.filter((p) => p.owner === owner).map((p) =>
          `- ${p.title} (${code(p.id)}) — due ${typeof p.due === "string" ? p.due : `when ${describeVerify(p.due)}`} · done when: ${describeVerify(p.verify)}` +
          (p.requires.length ? ` · requires: ${p.requires.map((r) => code(r.id)).join(", ")}` : ""),
        ),
      )}\n`;
    det("promises.md", `# Promises\n\n${sec("owner", "Owner")}\n${sec("agent", "Agent")}`);
  }

  // ideas.md
  det("ideas.md", `# Ideas (parked)\n\n${list(of("idea").map((i) => `- **${i.title}** (${code(i.id)}) — ${i.text} · waits because: ${i.reason} · revisit: ${describeVerify(i.verify)}${born(i)}`))}\n`);

  // roadmap.md
  {
    const goals = of("goal");
    const phases = [...new Map(goals.map((g) => [g.phase.name, g.phase.ends])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    det(
      "roadmap.md",
      `# Roadmap\n\n${phases.map(([name, ends]) => `## ${name} (ends ${ends})\n${goals.filter((g) => g.phase.name === name).map((g) =>
        `- ${g.title} (${code(g.id)}) — done when: ${describeVerify(g.verify)}${g.requires.length ? ` · requires: ${g.requires.map((r) => code(r.id)).join(", ")}` : ""}`).join("\n")}`).join("\n\n") || "- none"}\n`,
    );
  }

  // profile.md
  det("profile.md", `# Profile\n\n${list(facts.filter((f) => f.id.startsWith("self.")).map((f) => `- **${f.title}** — ${f.value} (${code(f.id)})`))}\n`);

  // AGENTS.md
  {
    const rules = of("rule");
    const groups = [...new Set(rules.map((r) => r.appliesTo))].sort();
    const protocol = o.approval ? `## alfredish (owner approval)\n${APPROVAL_PROTOCOL.map((l) => `- ${l}`).join("\n")}\n\n` : "";
    det("AGENTS.md", `# Agent rules\n\n${protocol}${groups.map((g) => `## ${g}\n${rules.filter((r) => r.appliesTo === g).map((r) => `- ${r.text} (${code(r.id)})`).join("\n")}`).join("\n\n") || "- none"}\n`);
  }

  // sessions/<id>.md and log.md
  for (const s of sessions) {
    const mine = defs.filter((d) => d.kind !== "session" && d.origin === s);
    let body = `# ${s.at} — ${s.topic}\n\n**Questions:**\n${s.questions.map((q) => `- ${q}`).join("\n")}\n`;
    for (const [kind, title] of SECTIONS) {
      const items = mine.filter((d) => d.kind === kind).sort(byId);
      if (items.length) body += `\n## ${title}\n${items.map((d) => `- ${d.title} (${code(d.id)})`).join("\n")}\n`;
    }
    det(`sessions/${s.id}.md`, body);
  }
  det("log.md", `# Log\n\n${list(sessions.map((s) => `- ${s.at} — ${s.topic} — ${defs.filter((d) => d.kind !== "session" && d.origin === s).length} definitions → \`sessions/${s.id}.md\``))}\n`);

  // library/<id>.md and library/INDEX.md
  const usedBy = (f: Finding) => facts.filter((x: FactDef) => x.verify.kind === "fromFinding" && x.verify.finding === f);
  for (const r of researches) det(`library/${r.id}.md`, researchPage(r, usedBy));
  det("library/INDEX.md", `# Library\n\n${list(researches.map((r) => `- [${r.title}](${r.id}.md) — ${r.at} — read when: ${r.readWhen}`))}\n`);

  // NOW.md (time dependent)
  {
    const reds = report.issues.filter((i) => i.status === "red").length;
    views.push({
      path: "NOW.md",
      deterministic: false,
      body:
        `# NOW\n> generated ${today} · ${reds ? `✗ ${reds} red` : "✓ all green"} · ${report.counts.definitions} definitions\n\n` +
        `## Red / yellow\n${list(report.issues.map((i) => `- ${MARK[i.status]} ${code(i.id)} — ${i.message}`))}\n\n` +
        `## Goals\n${list(of("goal").filter((g) => !report.results.get(g.id)?.done).map((g) => `- ${state(g)} — ${g.title} (${code(g.id)}) — ${g.phase.name}, ends ${g.phase.ends}`))}\n\n` +
        `## Open promises\n${list(of("promise").filter((p) => !report.results.get(p.id)?.done).map((p) => `- ${state(p)} — ${p.title} (${code(p.id)}) — ${valueOf(p)}`))}\n`,
    });
  }
  return views;
}

function researchPage(r: ResearchDef, usedBy: (f: Finding) => FactDef[]): string {
  const lines = Object.values(r.findings).map((f) => {
    const val = f.value === undefined ? "" : ` = ${f.value}`;
    const src = f.source === undefined ? "" : ` · source: ${typeof f.source === "string" ? f.source : f.source.path + (f.source.locator ? `#${f.source.locator}` : "")}`;
    const use = usedBy(f);
    const where = use.length
      ? ` · used by: ${use.map((u) => code(u.id)).join(", ")}`
      : f.parked
        ? ` · parked: ${f.parked.reason} (revisit: ${describeVerify(f.parked.revisitWhen)})`
        : " · UNUSED";
    return `- **${f.key}** — ${f.text}${val}${src}${where}`;
  });
  return (
    `# ${r.title} (${r.at})\n\n**Question:** ${r.question}\n**Read when:** ${r.readWhen}\n` +
    (r.rawData.length ? `**Raw data:** ${r.rawData.map(code).join(", ")}\n` : "") +
    `\n## Findings\n${lines.join("\n")}\n`
  );
}

export type { SessionDef };
