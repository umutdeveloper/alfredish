import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, compile } from "../src/compiler.ts";
import { nodeContext } from "../src/context.ts";
import { checkImports, checkPast, checkViews, diff, writeViews } from "../src/repo.ts";
import { snapshot } from "../src/snapshot.ts";
import { buildViews } from "../src/views.ts";
import { after, decision, fact, finding, fromFinding, goal, idea, page, research, review, rule, session } from "../src/dsl.ts";
import type { Def, ISODate } from "../src/types.ts";

const s1 = session({ id: "s.2026-10-01", title: "first", at: "2026-10-01", topic: "Market research", questions: ["What do they pay?"] });

function memory(question = "What do they pay?", value = "500 USD"): Def[] {
  const scan = research({
    id: "r.scan", title: "Job board scan", origin: s1, at: "2026-10-01", question, readWhen: "when pricing is discussed",
    findings: {
      median: finding({ text: "median fixed budget", value: "500 USD" }),
      regional: finding({ text: "regional dates", parked: { reason: "not our market", revisitWhen: after("2027-04-01") } }),
    },
  });
  const median = fact({ id: "f.median", title: "Median budget", origin: s1, value, verify: fromFinding(scan.findings.median, { ttl: "90d" }), evidence: "research" });
  const keep = decision({ id: "d.price", title: "Keep $290", origin: s1, restsOn: [median], review: "60d", verify: review({ by: "owner", at: "2026-10-01", every: "60d" }), evidence: "human" });
  const self = fact({ id: "self.city", title: "City", origin: s1, value: "Somewhere", verify: review({ by: "owner", at: "2026-10-01", every: "180d" }), evidence: "human", parked: { reason: "profile", revisitWhen: after("2027-01-01") } });
  const commits = rule({ id: "rule.commits", title: "English commits", origin: s1, text: "Commit messages are in English", appliesTo: "git", verify: review({ by: "owner", at: "2026-10-01", every: "90d" }), evidence: "human" });
  const later = idea({ id: "idea.title", title: "Title review", origin: s1, text: "Talk about the job title", reason: "focus elsewhere", revisitWhen: after("2026-12-01"), evidence: "human" });
  const launch = goal({ id: "goal.launch", title: "Launch the site", origin: s1, phase: { name: "Phase 0", ends: "2026-10-31" }, requires: [], doneWhen: page("https://example.invalid").contains("x"), evidence: "live" });
  return [s1, scan, median, keep, self, commits, later, launch];
}

let base: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: base, stdio: "pipe" }).toString();

async function run(roots: Def[], today: ISODate) {
  const ctx = nodeContext(base, 1);
  const repo = { base, memoryDir: "memory", ctx };
  const { defs } = collect(roots);
  const report = await compile(roots, { today, ctx });
  const snap = snapshot(defs);
  return { repo, defs, report, snap, views: buildViews(defs, report, today) };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "alfredish-"));
  await mkdir(join(base, "memory"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
});

describe("K6 — generated views", () => {
  it("after build, every view exists and is clean", async () => {
    const x = await run(memory(), "2026-10-03");
    const written = await writeViews(x.views, x.snap, x.repo);
    expect(written).toEqual(expect.arrayContaining([
      "NOW.md", "decisions.md", "promises.md", "ideas.md", "roadmap.md", "profile.md", "AGENTS.md", "log.md",
      "sessions/s.2026-10-01.md", "library/r.scan.md", "library/INDEX.md", "memory/snapshot.json",
    ]));
    expect(await checkViews(x.views, x.snap, x.repo)).toEqual([]);
  });

  it("a hand edit is caught", async () => {
    const x = await run(memory(), "2026-10-03");
    await writeViews(x.views, x.snap, x.repo);
    const p = join(base, "decisions.md");
    await writeFile(p, (await readFile(p, "utf8")) + "\n- a decision added by hand\n");
    expect(await checkViews(x.views, x.snap, x.repo)).toEqual([expect.objectContaining({ id: "decisions.md", rule: "K6", message: "edited by hand" })]);
  });

  it("a view not rebuilt after a change is stale", async () => {
    const before = await run(memory(), "2026-10-03");
    await writeViews(before.views, before.snap, before.repo);
    const after = await run(memory("What do they pay?", "600 USD"), "2026-10-03");
    expect((await checkViews(after.views, after.snap, after.repo)).map((i) => i.id)).toContain("memory/snapshot.json");
  });

  it("a hand-written note in library/ is not allowed", async () => {
    const x = await run(memory(), "2026-10-03");
    await writeViews(x.views, x.snap, x.repo);
    await writeFile(join(base, "library", "my-notes.md"), "# free notes\n");
    expect((await checkViews(x.views, x.snap, x.repo)).map((i) => i.id)).toEqual(["library/my-notes.md"]);
  });

  it("views say what each thing is for", async () => {
    const x = await run(memory(), "2026-10-03");
    const body = (p: string) => x.views.find((v) => v.path === p)!.body;
    expect(body("sessions/s.2026-10-01.md")).toContain("## Decisions\n- Keep $290 (`d.price`)");
    expect(body("library/r.scan.md")).toContain("**median** — median fixed budget = 500 USD · used by: `f.median`");
    expect(body("library/r.scan.md")).toContain("**regional** — regional dates · parked: not our market (revisit: after 2027-04-01)");
    expect(body("AGENTS.md")).toContain("## git\n- Commit messages are in English (`rule.commits`)");
    expect(body("ideas.md")).toContain("waits because: focus elsewhere · revisit: after 2026-12-01");
    expect(body("roadmap.md")).toContain("## Phase 0 (ends 2026-10-31)\n- Launch the site (`goal.launch`)");
    expect(body("profile.md")).toContain("- **City** — Somewhere (`self.city`)");
    expect(body("NOW.md")).toContain("- ✓ open — Launch the site (`goal.launch`)");
  });
});

describe("K5 — the past does not change", () => {
  it("editing research from a past day is red; same-day edits are allowed", async () => {
    const x = await run(memory(), "2026-10-03");
    await writeViews(x.views, x.snap, x.repo);
    git("add", "-A");
    git("commit", "-qm", "day one");
    const edited = await run(memory("Another question"), "2026-10-03");
    expect(await checkPast(edited.snap, "2026-10-03", edited.repo)).toEqual([expect.objectContaining({ id: "r.scan", rule: "K5", message: "past changed (2026-10-01)" })]);
    const sameDay = await run(memory("Another question"), "2026-10-01");
    expect(await checkPast(sameDay.snap, "2026-10-01", sameDay.repo)).toEqual([]);
  });

  it("deleting a past session is red", async () => {
    const x = await run(memory(), "2026-10-03");
    await writeViews(x.views, x.snap, x.repo);
    git("add", "-A");
    git("commit", "-qm", "day one");
    const gone = await run([], "2026-10-03");
    expect((await checkPast(gone.snap, "2026-10-03", gone.repo)).map((i) => i.id)).toEqual(["r.scan", "s.2026-10-01"]);
  });
});

describe("alfred diff", () => {
  it("shows meaning-level changes against a commit", async () => {
    const x = await run(memory(), "2026-10-03");
    await writeViews(x.views, x.snap, x.repo);
    git("add", "-A");
    git("commit", "-qm", "day one");
    const y = await run(memory("What do they pay?", "600 USD"), "2026-10-03");
    expect(await diff(y.defs, "HEAD", y.repo)).toEqual([{ op: "~", id: "f.median", kind: "fact", detail: 'value: "500 USD" → "600 USD"' }]);
  });
});

describe("K15 — imports stay inside the memory folder", () => {
  it("flags an import from outside the folder, accepts local ones", async () => {
    await mkdir(join(base, "vendor"));
    await writeFile(join(base, "memory", "ok.ts"), 'import { fact } from "../vendor/alfredish/src/index.ts";\nimport { x } from "./other.ts";\n');
    await writeFile(join(base, "memory", "bad.ts"), 'import { fact } from "/somewhere/else/alfredish/src/index.ts";\nimport { y } from "../../outside.ts";\n');
    const issues = await checkImports({ base, memoryDir: "memory", ctx: nodeContext(base) });
    expect(issues.map((i) => [i.id, i.rule])).toEqual([["memory/bad.ts", "K15"], ["memory/bad.ts", "K15"]]);
  });

  it("ignores the words 'from' and 'import' inside strings", async () => {
    await writeFile(join(base, "memory", "text.ts"), 'export const t = "changed from \'No trackers\' to \'No cookies\'; import \'x\' later";\n');
    expect(await checkImports({ base, memoryDir: "memory", ctx: nodeContext(base) })).toEqual([]);
  });
});
