import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, collect } from "../src/compiler.ts";
import { linkLine, linkedRules } from "../src/repo.ts";
import { buildViews } from "../src/views.ts";
import { readSigned } from "../src/context.ts";
import { decision, link, review, session } from "../src/dsl.ts";
import { recordName, sha256, signFile, type ApprovalRecord } from "../src/approval.ts";
import { describeVerify } from "../src/snapshot.ts";
import { shapeProblems } from "../src/validate.ts";
import type { ProbeContext } from "../src/types.ts";
import { fakeCtx } from "./helpers.ts";

// Two memories on one machine: "alfred" holds Umut's experience as he signed it; "golive" rests a decision on it.
let keys: string, alfred: string, memoriesFile: string;
const today = "2026-10-05" as const;
const s = session({ id: "s.2026-10-05", title: "s", at: today, topic: "t", questions: ["?"] });
const v1 = { kind: "fact", id: "self.experience", title: "Builds for the web since 2013", value: "13 years", evidence: "source" };
const v2 = { ...v1, title: "Builds for the web since 2012", value: "14 years" };
const H1 = "a1a1a1a1a1a1a1a1", H2 = "b2b2b2b2b2b2b2b2";

async function sign(n: number, approved: ApprovalRecord["approved"], prev?: string): Promise<string> {
  const rec: ApprovalRecord = { n, at: today, base: prev === undefined ? null : sha256(prev), alfredish: null, approved, removed: [], rejected: {}, corrections: {} };
  const text = JSON.stringify(rec, null, 1);
  const file = join(alfred, "approvals", recordName(n));
  await writeFile(file, text);
  const r = await signFile(file, join(keys, "owner"));
  if (!r.ok) throw new Error(r.out);
  return text;
}

beforeAll(async () => {
  keys = await mkdtemp(join(tmpdir(), "alfredish-link-keys-"));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "owner", "-f", join(keys, "owner")]);
  await writeFile(join(keys, "anchor.pub"), await readFile(join(keys, "owner.pub"), "utf8"));
  alfred = await mkdtemp(join(tmpdir(), "alfredish-link-alfred-"));
  await mkdir(join(alfred, "approvals"));
  await sign(1, { "self.experience": { kind: "fact", hash: H1, data: v1 } });
  memoriesFile = join(keys, "memories.json");
  await writeFile(memoriesFile, JSON.stringify({ alfred }));
});

const ctx = (): ProbeContext => ({ ...fakeCtx(), signed: (m, id, p) => readSigned(m, id, p, { memoriesFile, anchor: join(keys, "anchor.pub") }) });
const linked = (hash: string, o: { memory?: string; target?: string; evidence?: "source" | "live"; kind?: string } = {}) =>
  link({ id: "link.alfred.self.experience", title: "Umut's experience, as signed in Alfred", origin: s, memory: o.memory ?? "alfred", target: o.target ?? "self.experience", kind: o.kind ?? "fact", hash, evidence: o.evidence ?? "source" });
const claimOn = (l: ReturnType<typeof linked>) => decision({ id: "site.experienceText", title: "The site says 13 years", origin: s, restsOn: [l], review: "90d", verify: review({ by: "owner", at: today, every: "90d" }), evidence: "human" });
const run = async (l: ReturnType<typeof linked>) => {
  const r = await compile([claimOn(l)], { today, ctx: ctx() });
  return { link: r.results.get(l.id)!, onIt: r.results.get("site.experienceText")! };
};

describe("§9.2 link: resting on another memory's definition as its owner signed it", () => {
  it("green while the signed content still has the pinned hash", async () => {
    const r = await run(linked(H1));
    expect(r.link.status).toBe("green");
    expect(r.onIt.status).toBe("green");
  });

  it("yellow once the owner signs a change there — with what changed — and what rests on it turns yellow too", async () => {
    const prev = await readFile(join(alfred, "approvals", recordName(1)), "utf8");
    await sign(2, { "self.experience": { kind: "fact", hash: H2, data: v2 } }, prev);
    const r = await run(linked(H1));
    expect(r.link.status).toBe("yellow");
    expect(r.link.reasons.join()).toContain("alfred:self.experience changed since it was linked (title: Builds for the web since 2013 → Builds for the web since 2012; value: 13 years → 14 years) — look again, then re-link");
    expect(r.onIt.status).toBe("yellow");
    expect((await run(linked(H2))).link.status).toBe("green"); // re-linked to the new signed content
  });

  it("red when it cannot be read: an unknown memory, a definition not signed there, a claimed evidence it does not have", async () => {
    expect((await run(linked(H2, { memory: "nowhere" }))).link.reasons.join()).toContain('memory "nowhere" is not registered');
    expect((await run(linked(H2, { target: "self.missing" }))).link.reasons.join()).toContain("not in alfred's signed state");
    const r = await run(linked(H2, { evidence: "live" }));
    expect(r.link.status).toBe("red");
    expect(r.link.reasons.join()).toContain('linked with evidence "live", signed with "source"');
    expect((await run(linked(H2, { kind: "account" }))).link.reasons.join()).toContain("linked as a account, signed as a fact");
  });

  it("an asset lives on another memory's account through a link, never through a link to something else (K16)", async () => {
    const { asset, url } = await import("../src/dsl.ts");
    const github = link({ id: "link.alfred.account.github", title: "GitHub", origin: s, memory: "alfred", target: "account.github", kind: "account", hash: H1, evidence: "live" });
    const repo = asset({ id: "project.esik", title: "Eşik repo", origin: s, on: github, desired: "exists", location: url("https://github.com/umutdeveloper/esik"), verify: review({ by: "owner", at: today, every: "90d" }), evidence: "human" });
    expect(shapeProblems(repo)).toEqual([]);
    expect(shapeProblems({ ...repo, on: linked(H1) })).toContain("on is not an account, nor a link to another memory's account — link only to definitions (import the exported definition)");
  });

  it("red when the other memory's records do not check out — an edited record is never read as signed", async () => {
    const other = await mkdtemp(join(tmpdir(), "alfredish-link-forged-"));
    await mkdir(join(other, "approvals"));
    const file = join(other, "approvals", recordName(1));
    const forged = { n: 1, at: today, base: null, alfredish: null, approved: { "self.experience": { kind: "fact", hash: H1, data: v1 } }, removed: [], rejected: {}, corrections: {} };
    await writeFile(file, JSON.stringify(forged));
    await writeFile(`${file}.sig`, await readFile(join(alfred, "approvals", `${recordName(1)}.sig`), "utf8")); // a signature of other content
    const r = await readSigned("forged", "self.experience", H1, { memoriesFile: await (async () => { const f = join(keys, "forged.json"); await writeFile(f, JSON.stringify({ forged: other })); return f; })(), anchor: join(keys, "anchor.pub") });
    expect(r).toEqual({ why: expect.stringContaining("approval records do not check out") });
  });

  it("is described by everything it pins (K25), and is well-formed only when built with link() (K16)", () => {
    const l = linked(H1);
    expect(describeVerify(l.verify)).toBe(`linked to alfred:self.experience (fact, signed ${H1}, evidence source)`);
    expect(shapeProblems({ ...l, verify: { ...l.verify, hash: "nothex" } })).toContain("verify (linked): needs memory, target, kind, hash (16 hex) or follows, and evidence");
  });

  it("a link nothing rests on is red (K12)", async () => {
    const r = await compile([linked(H2)], { today, ctx: ctx() });
    expect(r.issues).toContainEqual(expect.objectContaining({ id: "link.alfred.self.experience", rule: "K12", message: "unused (nothing rests on this link)" }));
  });

  it("a linked rule of another memory shows in AGENTS.md as signed there, named with where it comes from", async () => {
    const R1 = "c3c3c3c3c3c3c3c3";
    const prev = await readFile(join(alfred, "approvals", recordName(2)), "utf8");
    await sign(3, { "rule.talk.honest": { kind: "rule", hash: R1, data: { kind: "rule", id: "rule.talk.honest", title: "Honest", appliesTo: "conversation", text: "Be honest: do not soften bad news.", evidence: "human" } } }, prev);
    const honest = link({ id: "link.alfred.rule.talk.honest", title: "Honest", origin: s, memory: "alfred", target: "rule.talk.honest", kind: "rule", hash: R1, evidence: "human" });
    const { defs } = collect([honest]);
    const rules = await linkedRules(defs, ctx());
    expect(rules).toEqual([{ link: "link.alfred.rule.talk.honest", from: "alfred:rule.talk.honest", text: "Be honest: do not soften bad news.", appliesTo: "conversation" }]);
    const report = await compile([honest], { today, ctx: ctx() });
    const agents = buildViews(defs, report, today, { linkedRules: rules }).find((v) => v.path === "AGENTS.md")!.body;
    expect(agents).toContain("## conversation\n- Be honest: do not soften bad news. (`alfred:rule.talk.honest`, linked)");
    expect(report.issues.filter((i) => i.rule === "K12")).toEqual([]); // a rule link is used by AGENTS.md itself
  });

  it("while a linked rule is yellow, AGENTS.md keeps the text this memory's owner approved", async () => {
    const prev = await readFile(join(alfred, "approvals", recordName(3)), "utf8");
    await sign(4, { "rule.talk.honest": { kind: "rule", hash: "d4d4d4d4d4d4d4d4", data: { kind: "rule", id: "rule.talk.honest", title: "Honest", appliesTo: "conversation", text: "Soften bad news a little.", evidence: "human" } } }, prev);
    const honest = link({ id: "link.alfred.rule.talk.honest", title: "Honest", origin: s, memory: "alfred", target: "rule.talk.honest", kind: "rule", hash: "c3c3c3c3c3c3c3c3", evidence: "human" });
    const rules = await linkedRules(collect([honest]).defs, ctx());
    expect(rules.map((r) => r.text)).toEqual(["Be honest: do not soften bad news."]);
    expect((await compile([honest], { today, ctx: ctx() })).results.get(honest.id)!.status).toBe("yellow");
  });
});

describe("§9.2 a link that follows the owner's rule instead of pinning it", () => {
  const follow = (o: { target?: string; kind?: string } = {}) =>
    link({ id: "link.alfred.rule.talk.honest", title: "Honest", origin: s, memory: "alfred", target: o.target ?? "rule.talk.honest", kind: o.kind ?? "rule", follows: true, evidence: "human" });

  it("is green after the owner signs a change there, and AGENTS.md shows the latest signed wording", async () => {
    const l = follow();
    expect((await compile([l], { today, ctx: ctx() })).results.get(l.id)!.status).toBe("green");
    expect((await linkedRules(collect([l]).defs, ctx())).map((r) => r.text)).toEqual(["Soften bad news a little."]);
  });

  it("its record never changes with its target, so the memory that follows needs no approval round", () => {
    expect(describeVerify(follow().verify)).toBe("linked to alfred:rule.talk.honest (rule, follows its signed wording, evidence human)");
  });

  it("is red when the rule is not in the other memory's signed state", async () => {
    const l = follow({ target: "rule.talk.never" });
    expect((await compile([l], { today, ctx: ctx() })).results.get(l.id)!.status).toBe("red");
  });

  it("only a rule is followed, and nothing may rest on a following link: what rests on it must see a change (pin it)", async () => {
    expect(shapeProblems(follow({ target: "self.experience", kind: "fact" }))).toContain("only a link to a rule may follow its target; pin anything else with its hash");
    const l = follow();
    const onIt = decision({ id: "d.onRule", title: "Rests on the rule", origin: s, restsOn: [l], review: "90d", verify: review({ by: "owner", at: today, every: "90d" }), evidence: "human" });
    expect((await compile([onIt], { today, ctx: ctx() })).issues).toContainEqual(expect.objectContaining({ id: l.id, status: "red", message: "d.onRule rests on this following link — a link something rests on pins its target: link it with its hash" }));
  });

  it("alfred link prints the following form for a rule and the pinned form for anything else", () => {
    expect(linkLine("alfred", "rule.talk.honest", { hash: "d4d4d4d4d4d4d4d4", data: { kind: "rule", title: "Honest", evidence: "human" } })).toBe(
      'link({ id: "link.alfred.rule.talk.honest", title: "Honest", origin: <this session>, memory: "alfred", target: "rule.talk.honest", kind: "rule", follows: true, evidence: "human" })');
    expect(linkLine("alfred", "self.experience", { hash: H1, data: { kind: "fact", title: "Exp", evidence: "source" } })).toBe(
      `link({ id: "link.alfred.self.experience", title: "Exp", origin: <this session>, memory: "alfred", target: "self.experience", kind: "fact", hash: "${H1}", evidence: "source" })`);
  });
});
