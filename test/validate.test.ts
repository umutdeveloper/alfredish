import { describe, it, expect } from "vitest";
import { collect, compile } from "../src/compiler.ts";
import { asset, account, decision, fact, local, promise, review, rule, session, url } from "../src/dsl.ts";
import { shapeProblems } from "../src/validate.ts";
import { fakeCtx } from "./helpers.ts";

const s1 = session({ id: "s.2026-10-01", title: "t", at: "2026-10-01", topic: "t", questions: ["?"] });
const ok = review({ by: "owner", at: "2026-10-01", every: "90d" });
const laptop = account({ id: "a.laptop", title: "Laptop", origin: s1, service: "macOS", owner: "owner", login: "me", agentAccess: "none", verify: ok, evidence: "human" });
const good = rule({ id: "r.ok", title: "A rule", origin: s1, appliesTo: "x", text: "Be kind.", verify: ok, evidence: "human" });
const bad = (x: object) => x as never; // what `as any` lets through

describe("K16 — type rules also hold at run time", () => {
  it("a well-formed definition has no problems", () => {
    expect(shapeProblems(good)).toEqual([]);
    expect(shapeProblems(asset({ id: "x", title: "t", origin: s1, on: laptop, desired: "d", location: local("/tmp", { confirmedBy: "owner", at: "2026-10-01" }), verify: ok, evidence: "human" }))).toEqual([]);
  });

  it.each([
    ["no verify", { ...good, verify: undefined }, "verify is missing or not a verification — give it a test"],
    ["unknown evidence", { ...good, evidence: "vibes" }, "evidence is missing or unknown"],
    ["no origin", { ...good, origin: undefined }, "origin is not a session — set origin to the session it was written in"],
    ["origin is not a session", { ...good, origin: good }, "origin is not a session"],
    ["unknown kind", { ...good, kind: "note" }, 'kind "note" is not an Alfredish kind'],
    ["review without a date", { ...good, verify: { kind: "review", by: "owner", every: "90d" } }, "verify (review): needs"],
    ["a string location", { ...asset({ id: "x", title: "t", origin: s1, on: laptop, desired: "d", location: url("https://e.com"), verify: ok, evidence: "human" }), location: "/Users/x" }, "location is not url() or local()"],
    ["a link that is not a definition", { ...decision({ id: "d", title: "t", origin: s1, restsOn: [], review: "90d", verify: ok, evidence: "human" }), restsOn: [undefined] }, "restsOn[0] is not a definition"],
    ["a promise without requires", { ...promise({ id: "p", title: "t", origin: s1, owner: "owner", due: "2026-12-01", requires: [], doneWhen: ok, evidence: "human" }), requires: undefined }, "requires is missing"],
    ["a fact without a value", { ...fact({ id: "f", title: "t", origin: s1, value: 1, verify: ok, evidence: "human" }), value: undefined }, "value is missing"],
  ])("%s is named, with the fix", (_, def, message) => {
    expect(shapeProblems(def).join(" | ")).toContain(message);
  });

  it("a malformed definition is reported, never crashes the compiler, and turns what rests on it red", async () => {
    const broken = bad({ ...fact({ id: "f.broken", title: "t", origin: s1, value: 1, verify: ok, evidence: "human" }), verify: undefined });
    const resting = decision({ id: "d.rests", title: "t", origin: s1, restsOn: [broken], review: "90d", verify: ok, evidence: "human" });
    const { defs, invalid } = collect([broken, resting]);
    expect(invalid.has(broken)).toBe(true);
    expect(defs).not.toContain(broken);
    const r = await compile([broken, resting], { today: "2026-10-02", ctx: fakeCtx() });
    expect(r.issues).toContainEqual(expect.objectContaining({ id: "f.broken", rule: "K16" }));
    expect(r.results.get("d.rests")?.status).toBe("red");
    expect(r.results.get("d.rests")?.reasons.join(" ")).toContain("depends on red: f.broken");
  });
});

describe("K19 — evidence cannot claim more than the test proves", () => {
  it("each verification kind has its ceiling; derived takes the weakest input", async () => {
    const { evidenceCeiling } = await import("../src/compiler.ts");
    const { derived, fromFinding, finding, research, page } = await import("../src/dsl.ts");
    const r = research({ id: "r", title: "t", origin: s1, at: "2026-10-01", question: "?", readWhen: "w", findings: { a: finding({ text: "x" }) } });
    const seen = fact({ id: "f.seen", title: "t", origin: s1, value: 1, verify: page("https://e.com").contains("x"), evidence: "live" });
    const said = fact({ id: "f.said", title: "t", origin: s1, value: 1, verify: ok, evidence: "human" });
    const found = fact({ id: "f.found", title: "t", origin: s1, value: 1, verify: fromFinding(r.findings.a, { ttl: "90d" }), evidence: "research" });
    expect([evidenceCeiling(seen), evidenceCeiling(said), evidenceCeiling(found)]).toEqual(["live", "human", "research"]);
    const both = fact({ id: "f.both", title: "t", origin: s1, value: 1, verify: derived([seen, found]), evidence: "research" });
    expect(evidenceCeiling(both)).toBe("research");
    const report = await compile([{ ...both, evidence: "live" }], { today: "2026-10-02", ctx: fakeCtx({ "https://e.com": { body: "x" } }) });
    expect(report.results.get("f.both")?.reasons.join(" ")).toContain('K19: evidence "live" is more than a derived can prove (at most "research")');
  });
});
