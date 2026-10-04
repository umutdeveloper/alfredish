// Mistakes a careless or weak agent will make, tried end to end against a real memory folder.
// Each test makes one mistake, then runs what the agent runs (`alfred build`), then the commit gate
// (`tsc` + `alfred check`). The question is always the same: does the gate refuse to call the memory green?
//
// A "HOLE:" test documents a known hole: it passes while the gate still calls the mistake green, and fails
// the day a change closes the hole — then move it to the caught tests and assert the rule that catches it.
// (Not `it.fails`: that would also pass when an attack breaks for an unrelated reason.)
import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 60_000;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (days: number) => iso(new Date(Date.now() + days * 86_400_000));
// Relative to the real today, because the CLI checks against the real today.
const TODAY = shift(0);
const OLD = shift(-2);
const DUE = shift(200);

// ---- a small fictional memory ----

const FILES: Record<string, string> = {
  "memory/lang.ts": `export * from "../vendor/alfredish/src/index.ts";\n`,
  "memory/sessions.ts": `import { session } from "./lang.ts";
export const sOld = session({ id: "s.old", title: "Earlier session", at: "${OLD}", topic: "Earlier session", questions: ["What do we keep?"] });
export const sToday = session({ id: "s.today", title: "Today's session", at: "${TODAY}", topic: "Today's session", questions: ["What changed?"] });
`,
  "memory/infra.ts": `import { account, asset, cmd, file, url } from "./lang.ts";
import { sOld } from "./sessions.ts";
export const laptop = account({ id: "account.laptop", title: "The owner's laptop", origin: sOld, service: "macOS", owner: "owner", login: "owner", agentAccess: "none", verify: cmd("node runs", "node", ["--version"]), evidence: "live" });
export const notes = asset({ id: "notes.repo", title: "Notes repository", origin: sOld, on: laptop, desired: "exists", location: url("https://example.com/notes"), verify: file("memory/index.ts").exists(), evidence: "live" });
`,
  "memory/rules.ts": `import { review, rule } from "./lang.ts";
import { sOld } from "./sessions.ts";
const ok = review({ by: "owner", at: "${OLD}", every: "365d" });
export const budget = rule({ id: "rule.budget", title: "Budget cap", origin: sOld, appliesTo: "money", text: "Spend at most 1,000 EUR a month.", verify: ok, evidence: "human" });
export const noInvestment = rule({ id: "rule.noInvestment", title: "No investment advice", origin: sOld, appliesTo: "advice", text: "Never give investment advice.", verify: ok, evidence: "human" });
`,
  "memory/decisions.ts": `import { decision, fact, key, review } from "./lang.ts";
import { sOld } from "./sessions.ts";
export const titleKey = key({ subject: "work", name: "jobTitle", valueType: "text", describe: "official job title", origin: sOld });
export const jobTitle = fact({ id: "work.title", title: "Official job title", origin: sOld, value: "Senior Developer", key: titleKey, verify: review({ by: "owner", at: "${OLD}", every: "180d" }), evidence: "human" });
export const focus = decision({ id: "work.focus", title: "Focus on the main job this year", origin: sOld, restsOn: [jobTitle], review: "30d", verify: review({ by: "owner", at: "${OLD}", every: "30d" }), evidence: "human" });
export const dispatch = decision({ id: "work.dispatch", title: "Tickets are worked in the work folder", origin: sOld, restsOn: [], review: "365d", verify: review({ by: "owner", at: "${OLD}", every: "365d" }), evidence: "human" });
`,
  "memory/promises.ts": `import { confirm, promise } from "./lang.ts";
import { sOld } from "./sessions.ts";
export const renew = promise({ id: "promise.renewDomain", title: "Renew the domain", origin: sOld, owner: "owner", due: "${DUE}", requires: [], doneWhen: confirm({ by: "owner", what: "domain renewed" }), evidence: "human" });
`,
  "memory/events.ts": `import { event } from "./lang.ts";
import { sOld } from "./sessions.ts";
export const started = event({ id: "event.started", title: "Memory started", origin: sOld, at: "${OLD}", text: "The memory was started." });
`,
  "memory/index.ts": ["sessions", "infra", "rules", "decisions", "promises", "events"].map((f) => `export * from "./${f}.ts";\n`).join(""),
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, exactOptionalPropertyTypes: true, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, types: ["node"] }, include: ["memory"] }, null, 2),
  "package.json": JSON.stringify({ name: "attack-memory", private: true, type: "module" }),
  ".gitignore": "node_modules\n.alfredish-cache.json\n",
};

// The same header every definition file above starts with, for files an attack adds.
const EXTRA_HEADER = `import { claim, cmd, decision, fact, key, local, probe, review, asset, url } from "./lang.ts";
import { sOld, sToday } from "./sessions.ts";
import { laptop } from "./infra.ts";
`;

// ---- running the gate ----

let baseline: string;

async function sh(dir: string, cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await exec(cmd, args, { cwd: dir, maxBuffer: 16 << 20 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: (x.stdout ?? "") + (x.stderr ?? "") };
  }
}
const git = (dir: string, ...a: string[]) => sh(dir, "git", a);
const alfred = (dir: string, ...a: string[]) => sh(dir, process.execPath, ["vendor/alfredish/src/cli.ts", ...a]);

/** What the agent runs (`build`, unless told not to), then the commit gate. Green only when both parts say so. */
async function gate(dir: string, o: { build?: boolean } = {}): Promise<{ green: boolean; out: string }> {
  if (o.build !== false) await alfred(dir, "build");
  const tsc = await sh(dir, process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
  const check = await alfred(dir, "check");
  const green = tsc.code === 0 && check.code === 0 && check.out.trimStart().startsWith("✓");
  return { green, out: tsc.out + check.out };
}

async function fresh(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "alfredish-attack-")), "m");
  await cp(baseline, dir, { recursive: true, verbatimSymlinks: true });
  return dir;
}

async function edit(dir: string, path: string, from: string, to: string): Promise<void> {
  const p = join(dir, path);
  const text = await readFile(p, "utf8");
  // A mistake that does not apply would make the test meaningless.
  if (!text.includes(from)) throw new Error(`attack does not apply: "${from}" not in ${path}`);
  await writeFile(p, text.replace(from, to));
}

/** Adds definitions in a new file and exports it, as an agent would. */
async function addDefs(dir: string, body: string): Promise<void> {
  await writeFile(join(dir, "memory/extra.ts"), EXTRA_HEADER + body);
  await edit(dir, "memory/index.ts", `export * from "./events.ts";\n`, `export * from "./events.ts";\nexport * from "./extra.ts";\n`);
}

beforeAll(async () => {
  baseline = join(await mkdtemp(join(tmpdir(), "alfredish-baseline-")), "m");
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(baseline, path)), { recursive: true });
    await writeFile(join(baseline, path), text);
  }
  // The memory carries its own copy of Alfredish (so attacks on it stay inside the copy); libraries are linked.
  await cp(join(REPO, "src"), join(baseline, "vendor/alfredish/src"), { recursive: true });
  await symlink(join(REPO, "node_modules"), join(baseline, "node_modules"));
  await symlink(join(REPO, "models"), join(baseline, "vendor/alfredish/models"));
  await git(baseline, "init", "-q");
  await git(baseline, "config", "user.email", "t@t");
  await git(baseline, "config", "user.name", "t");
  await alfred(baseline, "hook");
  await alfred(baseline, "build");
  await git(baseline, "add", "-A");
  const c = await git(baseline, "commit", "-qm", "baseline");
  if (c.code !== 0) throw new Error(`baseline does not commit:\n${c.out}`);
}, TIMEOUT);

/** Asserts the hole is still open: the gate ran and called the mistake green. */
function stillOpen(r: { green: boolean; out: string }): void {
  expect(r.green, `hole closed — move this test to the caught ones and assert the rule. Gate output:\n${r.out}`).toBe(true);
}

// ---- tests ----

describe.concurrent("attacks: mistakes the gate must refuse", () => {
  it("control: the untouched memory is green", async () => {
    const r = await gate(await fresh());
    expect(r.out).toMatch(/^\s*✓/);
    expect(r.green).toBe(true);
  }, TIMEOUT);

  // -- caught today --

  it("changing a past event is caught (K5)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/events.ts", "The memory was started.", "The memory was started much earlier.");
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain("K5: past changed");
  }, TIMEOUT);

  it("hand-editing a generated view is caught (K6)", async () => {
    const dir = await fresh();
    await writeFile(join(dir, "NOW.md"), (await readFile(join(dir, "NOW.md"), "utf8")) + "\nhand note\n");
    const r = await gate(dir, { build: false });
    expect(r.green).toBe(false);
    expect(r.out).toContain("K6: edited by hand");
  }, TIMEOUT);

  it("a plain string as a location is caught (K15, type level)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/infra.ts", `location: url("https://example.com/notes")`, `location: "/Users/someone/notes"`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain("TS2322");
  }, TIMEOUT);

  it("a link to a definition that does not exist is caught (K2, type level)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/decisions.ts", "restsOn: [jobTitle]", "restsOn: [jobTitleTypo]");
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain("Cannot find name 'jobTitleTypo'");
  }, TIMEOUT);

  it("a type rule silenced with `as any` is caught (K16 location, K17 escape)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/infra.ts", `location: url("https://example.com/notes")`, `location: "my-laptop-folder" as any`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain("K16: location is not url() or local()");
    expect(r.out).toMatch(/memory\/infra\.ts:\d+ — K17: as any/);
  }, TIMEOUT);

  it("a definition whose test is silenced with `as any` is caught by name, without a crash (K16, K17)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/rules.ts", `text: "Never give investment advice.", verify: ok,`, `text: "Never give investment advice.", verify: undefined as any,`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain("rule.noInvestment — K16: verify is missing or not a verification — give it a test");
    expect(r.out).not.toMatch(/TypeError|ReferenceError/);
  }, TIMEOUT);

  it("a type error silenced with `@ts-ignore` is caught (K17, and K16 for what it hid)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/infra.ts", `export const notes = asset({`, `// @ts-ignore\nexport const notes = asset({`);
    await edit(dir, "memory/infra.ts", `location: url("https://example.com/notes")`, `location: "my-laptop-folder"`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toMatch(/memory\/infra\.ts:\d+ — K17: @ts-ignore/);
    expect(r.out).toContain("K16: location is not url() or local()");
  }, TIMEOUT);

  it("an owner-reviewed fact labelled 'live' behind a public claim is caught (K19)", async () => {
    const dir = await fresh();
    await addDefs(dir, `export const lie = fact({ id: "site.customers", key: key({ subject: "siteCustomers", name: "count", valueType: "number", describe: "number of happy customers", origin: sToday }), title: "Happy customers", origin: sToday, value: 100, verify: review({ by: "owner", at: "${TODAY}", every: "90d" }), evidence: "live" });
export const lieClaim = claim({ id: "site.claim.customers", title: "Site: 100 happy customers", origin: sToday, text: "100 happy customers", where: url("https://example.com/"), restsOn: [lie], verify: cmd("node runs", "node", ["--version"]), evidence: "live" });\n`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain(`site.customers — K19: evidence "live" is more than a review can prove (at most "human")`);
    expect(r.out).toContain("site.claim.customers — depends on red: site.customers");
  }, TIMEOUT);

  it("a deleted present-tense rule is caught (K20); retiring it in an event dated today is accepted", async () => {
    const dir = await fresh();
    const p = join(dir, "memory/rules.ts");
    await writeFile(p, (await readFile(p, "utf8")).replace(/export const noInvestment = rule\(.*\n/, ""));
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain(`rule.noInvestment — K20: removed since the last commit — record it in an event dated ${TODAY} with retires: ["rule.noInvestment"]`);
    await edit(dir, "memory/events.ts", `import { sOld } from "./sessions.ts";`, `import { sOld, sToday } from "./sessions.ts";`);
    const e = join(dir, "memory/events.ts");
    await writeFile(e, (await readFile(e, "utf8")) + `export const retired = event({ id: "event.retired", title: "Rule dropped", origin: sToday, at: "${TODAY}", text: "The owner dropped the advice rule.", retires: ["rule.noInvestment"] });\n`);
    expect((await gate(dir)).green).toBe(true);
  }, TIMEOUT);

  it("a definition in a file the index does not export is caught (K18)", async () => {
    const dir = await fresh();
    await writeFile(join(dir, "memory/hidden.ts"), `import { cmd, fact, key } from "./lang.ts";
import { sToday } from "./sessions.ts";
export const hidden = fact({ id: "work.serverDown", key: key({ subject: "server", name: "status", valueType: "text", describe: "whether the server answers", origin: sToday }), title: "The server is down", origin: sToday, value: "down", verify: cmd("server answers", "false", []), evidence: "live" });\n`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain("work.serverDown — K18: defined in memory/hidden.ts but not reachable from the index");
  }, TIMEOUT);

  it("a new decision back-dated into a committed session is caught (K21); a session migrated in the same commit is accepted", async () => {
    const dir = await fresh();
    await addDefs(dir, `export const backdated = decision({ id: "work.backdated", title: "We decided this long ago", origin: sOld, restsOn: [], review: "365d", verify: review({ by: "owner", at: "${OLD}", every: "365d" }), evidence: "human" });\n`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain("work.backdated — K21: new, but born in s.old");
    const fresh2 = await fresh();
    await addDefs(fresh2, `import { session } from "./lang.ts";
export const sMigrated = session({ id: "s.migrated", title: "Old notes", at: "2026-01-05", topic: "Old notes", questions: ["What did we decide then?"] });
export const migrated = decision({ id: "work.migrated", title: "An old decision, moved in", origin: sMigrated, restsOn: [], review: "3650d", verify: review({ by: "owner", at: "${TODAY}", every: "3650d" }), evidence: "human" });\n`);
    expect((await gate(fresh2)).green).toBe(true);
  }, TIMEOUT);

  it("a second value for an existing property, under the same key, is caught (K22)", async () => {
    const dir = await fresh();
    await addDefs(dir, `import { titleKey } from "./decisions.ts";
export const title2 = fact({ id: "work.title2", title: "Job title", origin: sToday, value: "Principal Engineer", key: titleKey, verify: review({ by: "owner", at: "${TODAY}", every: "180d" }), evidence: "human" });\n`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toContain("K22: two values for key:work.jobTitle: work.title, work.title2");
  }, TIMEOUT);

  it("a second value under a renamed key is caught (K23); a real new property passes once decided", async () => {
    const dir = await fresh();
    await addDefs(dir, `import { titleKey } from "./decisions.ts";
export const roleKey = key({ subject: "work", name: "officialRole", valueType: "text", describe: "official job title held", origin: sToday });
export const title2 = fact({ id: "work.title2", title: "Job title", origin: sToday, value: "Principal Engineer", key: roleKey, verify: review({ by: "owner", at: "${TODAY}", every: "180d" }), evidence: "human" });
export const usesTitle2 = decision({ id: "work.usesTitle2", title: "Uses the role", origin: sToday, restsOn: [title2], review: "90d", verify: review({ by: "owner", at: "${TODAY}", every: "90d" }), evidence: "human" });\n`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toMatch(/key:work\.officialRole — K23: new key is close to: key:work\.jobTitle \(0\.\d\d\)/);
    await edit(dir, "memory/extra.ts", `describe: "official job title held", origin: sToday });`, `describe: "official job title held", origin: sToday, distinctFrom: [titleKey] });`);
    const after = await gate(dir);
    expect(after.green, after.out).toBe(true);
  }, TIMEOUT);

  it("`alfred keys <subject> --like` shows the closest existing keys before a new one is opened", async () => {
    const dir = await fresh();
    const list = await alfred(dir, "keys", "work");
    expect(list.out).toContain("key:work.jobTitle — text · official job title");
    const like = await alfred(dir, "keys", "work", "--like", "the role written on the contract");
    expect(like.out).toMatch(/^0\.\d\d  key:work\.jobTitle — official job title/m);
  }, TIMEOUT);

  it("a contradicting second fact cannot hide: its new key is close to the existing one (K23)", async () => {
    const dir = await fresh();
    await addDefs(dir, `import { titleKey } from "./decisions.ts";
export const k2 = key({ subject: "work", name: "position", valueType: "text", describe: "official job title on paper", origin: sToday });
export const jobTitle2 = fact({ id: "work.position", key: k2, title: "Official job title", origin: sToday, value: "Principal Engineer", verify: review({ by: "owner", at: "${TODAY}", every: "180d" }), evidence: "human" });
export const rests = decision({ id: "work.restsOnBoth", title: "Plan on the title", origin: sToday, restsOn: [jobTitle2], review: "90d", verify: review({ by: "owner", at: "${TODAY}", every: "90d" }), evidence: "human" });\n`);
    const r = await gate(dir);
    expect(r.green).toBe(false);
    expect(r.out).toMatch(/key:work\.position — K23: new key is close to: key:work\.jobTitle/);
  }, TIMEOUT);

  // -- known holes: the gate still says green --

  it("HOLE: a local path in free text ($HOME form)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/decisions.ts", "worked in the work folder", "worked in $HOME/work");
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: a local path in free text (relative form)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/decisions.ts", "worked in the work folder", "worked in ../../work");
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: the agent marks a local path as confirmed by the owner", async () => {
    const dir = await fresh();
    await addDefs(dir, `export const forged = asset({ id: "work.forged", title: "Some folder", origin: sToday, on: laptop, desired: "exists", location: local("/tmp/anything", { confirmedBy: "owner", at: "${TODAY}" }), verify: cmd("node runs", "node", ["--version"]), evidence: "live" });\n`);
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: the agent re-approves a decision on the owner's behalf", async () => {
    const dir = await fresh();
    await edit(dir, "memory/decisions.ts", `review: "30d", verify: review({ by: "owner", at: "${OLD}"`, `review: "30d", verify: review({ by: "owner", at: "${TODAY}"`);
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: a test written to always pass (probe that returns ok)", async () => {
    const dir = await fresh();
    await addDefs(dir, `export const fakeTest = decision({ id: "work.pipeline", title: "The deploy pipeline is healthy", origin: sToday, restsOn: [], review: "30d", verify: probe("pipeline is green", async () => ({ ok: true })), evidence: "live" });\n`);
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: a test written to always pass (command `true`)", async () => {
    const dir = await fresh();
    await addDefs(dir, `export const fakeCmd = decision({ id: "work.backups", title: "Backups run every night", origin: sToday, restsOn: [], review: "30d", verify: cmd("a backup exists", "true", []), evidence: "live" });\n`);
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: a rule is quietly weakened (budget 1,000 -> 100,000 EUR)", async () => {
    const dir = await fresh();
    await edit(dir, "memory/rules.ts", "Spend at most 1,000 EUR", "Spend at most 100,000 EUR");
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: a promise's due date is quietly postponed", async () => {
    const dir = await fresh();
    await edit(dir, "memory/promises.ts", `due: "${DUE}"`, `due: "2099-01-01"`);
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: a contradicting second fact passes when the agent falsely declares its key distinct (only owner approval sees it)", async () => {
    const dir = await fresh();
    await addDefs(dir, `import { titleKey } from "./decisions.ts";
export const k2 = key({ subject: "work", name: "position", valueType: "text", describe: "official job title on paper", origin: sToday, distinctFrom: [titleKey] });
export const jobTitle2 = fact({ id: "work.position", key: k2, title: "Official job title", origin: sToday, value: "Principal Engineer", verify: review({ by: "owner", at: "${TODAY}", every: "180d" }), evidence: "human" });
export const rests = decision({ id: "work.restsOnBoth", title: "Plan on the title", origin: sToday, restsOn: [jobTitle2], review: "90d", verify: review({ by: "owner", at: "${TODAY}", every: "90d" }), evidence: "human" });\n`);
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: memory text written in another language than agreed", async () => {
    const dir = await fresh();
    await edit(dir, "memory/decisions.ts", "Tickets are worked in the work folder", "Ticket'lar iş klasöründe çalışılır");
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: a password written into memory text", async () => {
    const dir = await fresh();
    await edit(dir, "memory/decisions.ts", "Tickets are worked in the work folder", "Tickets are worked in the work folder; server password hunter2");
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: the memory's own copy of Alfredish is edited to hide red results", async () => {
    const dir = await fresh();
    await edit(dir, "vendor/alfredish/src/compiler.ts", "  issues.sort(", "  issues.length = 0;\n  issues.sort(");
    await addDefs(dir, `export const down = fact({ id: "work.down", key: key({ subject: "server", name: "status", valueType: "text", describe: "whether the server answers", origin: sToday }), title: "The server is down", origin: sToday, value: "down", verify: cmd("server answers", "false", []), evidence: "live" });
export const rests = decision({ id: "work.restsOnDown", title: "Keep the server", origin: sToday, restsOn: [down], review: "30d", verify: review({ by: "owner", at: "${TODAY}", every: "30d" }), evidence: "human" });\n`);
    stillOpen(await gate(dir));
  }, TIMEOUT);

  it("HOLE: the past is rewritten and committed past the hook (--no-verify); later checks see nothing", async () => {
    const dir = await fresh();
    await edit(dir, "memory/events.ts", "The memory was started.", "The memory was started much earlier.");
    await alfred(dir, "build");
    await git(dir, "add", "-A");
    // The hook does stop a normal commit…
    expect((await git(dir, "commit", "-qm", "rewrite")).code).not.toBe(0);
    // …but not one that skips it, and K5 then compares against the rewritten HEAD.
    expect((await git(dir, "commit", "-q", "--no-verify", "-m", "rewrite")).code).toBe(0);
    stillOpen(await gate(dir));
  }, TIMEOUT);
});
