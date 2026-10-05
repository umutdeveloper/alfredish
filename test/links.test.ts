import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/compiler.ts";
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
const linked = (hash: string, o: { memory?: string; target?: string; evidence?: "source" | "live" } = {}) =>
  link({ id: "link.alfred.self.experience", title: "Umut's experience, as signed in Alfred", origin: s, memory: o.memory ?? "alfred", target: o.target ?? "self.experience", hash, evidence: o.evidence ?? "source" });
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
    expect(describeVerify(l.verify)).toBe(`linked to alfred:self.experience (signed ${H1}, evidence source)`);
    expect(shapeProblems({ ...l, verify: { ...l.verify, hash: "nothex" } })).toContain("verify (linked): needs memory, target, hash (16 hex) and evidence");
  });

  it("a link nothing rests on is red (K12)", async () => {
    const r = await compile([linked(H2)], { today, ctx: ctx() });
    expect(r.issues).toContainEqual(expect.objectContaining({ id: "link.alfred.self.experience", rule: "K12", message: "unused (nothing rests on this link)" }));
  });
});
