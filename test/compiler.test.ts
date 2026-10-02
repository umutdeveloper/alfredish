import { describe, it, expect } from "vitest";
import { compile, ttlStatus } from "../src/compiler.ts";
import { formatCheck } from "../src/format.ts";
import {
  account, after, agentProbe, asset, claim, confirm, decision, derived, fact, file, finding, fromFinding, goal, header, idea, local,
  page, promise, raw, research, review, rule, source,
} from "../src/dsl.ts";
import type { PresentDef } from "../src/types.ts";
import { fakeCtx, reviewed, s1 } from "./helpers.ts";

const today = "2026-10-03" as const;
const keep = (restsOn: readonly PresentDef[]) =>
  decision({ id: "d.keep", title: "decision", origin: s1, restsOn, review: "60d", verify: review({ by: "owner", at: "2026-10-01", every: "60d" }), evidence: "human" });
const status = async (defs: unknown[], id: string, pages = {}) => (await compile(defs, { today, ctx: fakeCtx(pages) })).results.get(id)!.status;

describe("probes", () => {
  it("page.contains is green when the text is on the page, red otherwise", async () => {
    const f = fact({ id: "f", title: "f", origin: s1, value: "x", verify: page("https://s").contains("No cookies"), evidence: "live" });
    expect(await status([f, keep([f])], "f", { "https://s": { body: "<p>No cookies</p>" } })).toBe("green");
    expect(await status([f, keep([f])], "f", { "https://s": { body: "<p>No trackers</p>" } })).toBe("red");
  });

  it("header.contains checks response headers", async () => {
    const f = fact({ id: "csp", title: "csp", origin: s1, value: "beacon allowed", evidence: "live", verify: header("https://s", "content-security-policy").contains("analytics.example.net") });
    expect(await status([f, keep([f])], "csp", { "https://s": { headers: { "content-security-policy": "script-src https://analytics.example.net" } } })).toBe("green");
  });

  it("a probe that cannot run is unknown, never green (§8)", async () => {
    const f = fact({ id: "f", title: "f", origin: s1, value: "x", verify: page("https://down").contains("x"), evidence: "live" });
    expect(await status([f, keep([f])], "f", { "https://down": new Error("offline") })).toBe("unknown");
  });
});

describe("confirm and after", () => {
  it("confirm without a date is not satisfied; with a date it is", async () => {
    const r1 = rule({ id: "r1", title: "r", origin: s1, text: "t", appliesTo: "x", verify: confirm({ by: "owner" }), evidence: "human" });
    const r2 = rule({ id: "r2", title: "r", origin: s1, text: "t", appliesTo: "x", verify: confirm({ by: "owner", at: "2026-10-02" }), evidence: "human" });
    expect(await status([r1], "r1")).toBe("red");
    expect(await status([r2], "r2")).toBe("green");
  });

  it("after(date) is satisfied from that day on", async () => {
    const mk = (d: `${number}-${number}-${number}`) => rule({ id: `r.${d}`, title: "r", origin: s1, text: "t", appliesTo: "x", verify: after(d), evidence: "human" });
    expect(await status([mk("2026-10-03")], "r.2026-10-03")).toBe("green");
    expect(await status([mk("2026-10-04")], "r.2026-10-04")).toBe("red");
  });
});

describe("K3 — propagation", () => {
  it("a red fact turns everything resting on it red, with the chain", async () => {
    const f = fact({ id: "price", title: "price", origin: s1, value: "100", verify: page("https://s").contains("$100"), evidence: "live" });
    const c = claim({ id: "c", title: "c", origin: s1, text: "t", where: "https://s", restsOn: [f], verify: page("https://s").contains("t"), evidence: "live" });
    const r = await compile([f, c, keep([f])], { today, ctx: fakeCtx({ "https://s": { body: "t $200" } }) });
    expect(r.results.get("price")!.status).toBe("red");
    expect(r.results.get("c")!.status).toBe("red");
    expect(r.results.get("d.keep")!.reasons.join()).toContain("depends on red: price");
  });
});

describe("K4 — public claims", () => {
  it("rejects a weak fact that bypassed the type check", async () => {
    const weak = fact({ id: "weak", title: "w", origin: s1, value: 1, verify: source("https://x", { readAt: "2026-10-01", ttl: "30d" }), evidence: "codeRead" });
    const c = claim({ id: "c", title: "c", origin: s1, text: "t", where: "https://s", verify: page("https://s").contains("t"), evidence: "live", restsOn: [weak as never] });
    const r = await compile([c], { today, ctx: fakeCtx({ "https://s": { body: "t" } }) });
    expect(r.results.get("c")!.reasons.join()).toContain("K4");
  });

  it("accepts our own decision as the basis of a claim", async () => {
    const c = claim({ id: "c", title: "c", origin: s1, text: "$290", where: "https://s", verify: page("https://s").contains("$290"), evidence: "live", restsOn: [keep([])] });
    expect(await status([c], "c", { "https://s": { body: "$290" } })).toBe("green");
  });
});

describe("K8 — expiry", () => {
  it("green inside the window, yellow in the last 20%, red after", () => {
    expect(ttlStatus("2026-10-01", "30d", "2026-10-10").status).toBe("green");
    expect(ttlStatus("2026-10-01", "30d", "2026-10-27").status).toBe("yellow");
    expect(ttlStatus("2026-10-01", "30d", "2026-11-05").status).toBe("red");
  });

  it("an agent probe never run is red, and propagates through `on`", async () => {
    const acc = account({ id: "host", title: "host", origin: s1, service: "host", owner: "owner", login: "o@example.com", agentAccess: "browserSession", verify: agentProbe("login shown", "30d"), evidence: "live" });
    const a = asset({ id: "site", title: "site", origin: s1, on: acc, desired: "x", location: "https://s", verify: page("https://s").contains("x"), evidence: "live" });
    const r = await compile([a], { today, ctx: fakeCtx({ "https://s": { body: "x" } }) });
    expect(r.results.get("host")!.status).toBe("red");
    expect(r.results.get("site")!.status).toBe("red");
  });
});

describe("promises, goals and ideas", () => {
  const notDone = page("https://s").contains("done");
  const mk = (due: `${number}-${number}-${number}`) => promise({ id: `p.${due}`, title: "p", origin: s1, owner: "owner", due, requires: [], doneWhen: notDone, evidence: "human" });

  it("dated promise: far → green, near → yellow, past → red, done → green", async () => {
    const r = await compile([mk("2026-12-01"), mk("2026-10-03"), mk("2026-10-02")], { today, ctx: fakeCtx({ "https://s": { body: "" } }) });
    expect(r.results.get("p.2026-12-01")!.status).toBe("green");
    expect(r.results.get("p.2026-10-03")!.status).toBe("yellow");
    expect(r.results.get("p.2026-10-02")!.status).toBe("red");
    expect(await status([mk("2026-10-02")], "p.2026-10-02", { "https://s": { body: "done" } })).toBe("green");
  });

  it("a promise due on a condition turns red when the condition comes true and it is not done", async () => {
    const firstSale = page("https://shop").contains("order #1");
    const p = promise({ id: "p", title: "ask the accountant", origin: s1, owner: "owner", due: firstSale, requires: [], doneWhen: confirm({ by: "owner" }), evidence: "human" });
    expect(await status([p], "p", { "https://shop": { body: "no orders" } })).toBe("green");
    expect(await status([p], "p", { "https://shop": { body: "order #1" } })).toBe("red");
  });

  it("a goal whose phase ended without its done condition is red", async () => {
    const g = goal({ id: "g", title: "g", origin: s1, phase: { name: "weeks 1-2", ends: "2026-10-02" }, requires: [], doneWhen: notDone, evidence: "live" });
    expect(await status([g], "g", { "https://s": { body: "" } })).toBe("red");
  });

  it("a derived condition comes true only when its inputs are satisfied, and an idea is never red", async () => {
    const g = goal({ id: "g.customers", title: "first customers", origin: s1, phase: { name: "p1", ends: "2026-10-04" }, requires: [], doneWhen: page("https://s").contains("2 customers"), evidence: "human" });
    const i = idea({ id: "i.expand", title: "expand", origin: s1, text: "t", reason: "after first customers", revisitWhen: derived([g]), evidence: "human" });
    expect(await status([i], "i.expand", { "https://s": { body: "0 customers" } })).toBe("green");
    expect(await status([i], "i.expand", { "https://s": { body: "2 customers" } })).toBe("yellow");
    const lateGoal = goal({ id: "g.late", title: "late", origin: s1, phase: { name: "p0", ends: "2026-10-02" }, requires: [], doneWhen: page("https://s").contains("never"), evidence: "human" });
    const i2 = idea({ id: "i.late", title: "late", origin: s1, text: "t", reason: "r", revisitWhen: derived([lateGoal]), evidence: "human" });
    const r = await compile([i2], { today, ctx: fakeCtx({ "https://s": { body: "" } }) });
    expect(r.results.get("g.late")!.status).toBe("red");
    expect(r.results.get("i.late")!.status).toBe("green");
  });

  it("a promise's due condition is not a dependency: a red input does not make the promise red", async () => {
    const g = goal({ id: "g.red", title: "red goal", origin: s1, phase: { name: "p0", ends: "2026-10-02" }, requires: [], doneWhen: page("https://s").contains("never"), evidence: "human" });
    const p = promise({ id: "p.cond", title: "p", origin: s1, owner: "owner", due: derived([g]), requires: [], doneWhen: confirm({ by: "owner" }), evidence: "human" });
    expect(await status([p], "p.cond", { "https://s": { body: "" } })).toBe("green");
  });

  it("an idea is never red; it turns yellow when its revisit condition comes true", async () => {
    const mkIdea = (d: `${number}-${number}-${number}`) => idea({ id: `i.${d}`, title: "i", origin: s1, text: "talk about the title", reason: "focus is elsewhere", revisitWhen: after(d), evidence: "human" });
    expect(await status([mkIdea("2026-12-01")], "i.2026-12-01")).toBe("green");
    expect(await status([mkIdea("2026-10-01")], "i.2026-10-01")).toBe("yellow");
  });
});

describe("K14 — preconditions", () => {
  it("a goal far from its deadline is red at once if a precondition is red", async () => {
    const acc = account({ id: "analytics", title: "analytics account", origin: s1, service: "analytics", owner: "owner", login: "o@example.com", agentAccess: "none", verify: reviewed, evidence: "human" });
    const installed = asset({ id: "measure.analytics", title: "analytics installed", origin: s1, on: acc, desired: "installed", location: "https://s", verify: page("https://s").contains("analytics.js"), evidence: "live" });
    const monthly = goal({ id: "measure.monthly", title: "monthly analytics report", origin: s1, phase: { name: "monthly", ends: "2026-12-31" }, requires: [installed], doneWhen: page("https://s").contains("never"), evidence: "live" });
    const r = await compile([monthly], { today, ctx: fakeCtx({ "https://s": { body: "<html>no analytics</html>" } }) });
    expect(r.results.get("measure.monthly")!.status).toBe("red");
    expect(r.results.get("measure.monthly")!.reasons.join()).toContain("depends on red: measure.analytics");
  });
});

describe("K12 — unused knowledge", () => {
  const scan = research({
    id: "r.scan", title: "scan", origin: s1, at: "2026-10-01", question: "what do they pay?", readWhen: "pricing",
    rawData: ["exists/scan.csv"],
    findings: {
      median: finding({ text: "median", value: "500 USD", source: raw("exists/scan.csv", "budget") }),
      regional: finding({ text: "regional dates", parked: { reason: "not our market", revisitWhen: page("https://eu").contains("open") } }),
      orphan: finding({ text: "a finding nobody uses" }),
    },
  });
  const median = fact({ id: "f.median", title: "median", origin: s1, value: "500 USD", verify: fromFinding(scan.findings.median, { ttl: "90d" }), evidence: "research" });

  it("flags unused findings and facts, accepts used and parked ones", async () => {
    const lonely = fact({ id: "f.lonely", title: "lonely", origin: s1, value: 1, verify: source("https://x", { readAt: "2026-10-01", ttl: "30d" }), evidence: "source" });
    const r = await compile([keep([median]), lonely], { today, ctx: fakeCtx({ "https://eu": { body: "" } }) });
    const ids = r.issues.filter((i) => i.rule === "K12").map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["r.scan#orphan", "f.lonely"]));
    expect(ids).not.toContain("r.scan#median");
    expect(ids).not.toContain("r.scan#regional");
  });

  it("parked knowledge turns yellow when its revisit condition comes true", async () => {
    const r = await compile([keep([median])], { today, ctx: fakeCtx({ "https://eu": { body: "open" } }) });
    expect(r.issues.find((i) => i.id === "r.scan#regional")?.status).toBe("yellow");
  });

  it("raw data must exist and be the source of some finding", async () => {
    const r2 = research({ id: "r.two", title: "t", origin: s1, at: "2026-10-01", question: "?", readWhen: "-", rawData: ["missing/a.csv", "exists/unused.csv"], findings: { x: finding({ text: "x", source: raw("missing/a.csv") }) } });
    const fx = fact({ id: "f.x", title: "x", origin: s1, value: 1, verify: fromFinding(r2.findings.x, { ttl: "30d" }), evidence: "research" });
    const ctx = fakeCtx();
    const r = await compile([keep([fx])], { today, ctx, fileExists: ctx.fileExists });
    expect(r.results.get("r.two")!.status).toBe("red");
    expect(r.issues.some((i) => i.id === "r.two:exists/unused.csv" && i.rule === "K12")).toBe(true);
  });

  it("an account no asset uses is flagged", async () => {
    const acc = account({ id: "acc", title: "a", origin: s1, service: "x", owner: "owner", login: "u", agentAccess: "none", verify: reviewed, evidence: "human" });
    const r = await compile([acc], { today, ctx: fakeCtx() });
    expect(r.issues.some((i) => i.id === "acc" && i.rule === "K12")).toBe(true);
  });
});

describe("K10 — no secrets", () => {
  it("stops on token-like strings", async () => {
    const r1 = rule({ id: "r", title: "r", origin: s1, text: "token ghp_abcdefghijklmnopqrstuvwxyz0123", appliesTo: "all", verify: reviewed, evidence: "human" });
    const r = await compile([r1], { today, ctx: fakeCtx() });
    expect(r.issues.some((i) => i.rule === "K10")).toBe(true);
  });
});

describe("K15 — local paths", () => {
  const acc = account({ id: "git", title: "git host", origin: s1, service: "git", owner: "owner", login: "o", agentAccess: "none", verify: reviewed, evidence: "human" });

  it("a local path is red and asks for the canonical address", async () => {
    const a = asset({ id: "code", title: "site code", origin: s1, on: acc, desired: "exists", location: "~/Projects/site", verify: reviewed, evidence: "human" });
    const r = await compile([a], { today, ctx: fakeCtx() });
    const k15 = r.issues.find((i) => i.rule === "K15");
    expect(k15?.id).toBe("code");
    expect(k15?.message).toContain("what should be written instead");
  });

  it("an owner-confirmed local path is accepted", async () => {
    const lp = local("/Users/owner/backup.sparsebundle", { confirmedBy: "owner", at: "2026-10-01" });
    const a = asset({ id: "backup", title: "backup", origin: s1, on: acc, desired: "exists", location: lp, verify: file(lp).exists(), evidence: "live" });
    const r = await compile([a], { today, ctx: fakeCtx() });
    expect(r.issues.filter((i) => i.rule === "K15")).toEqual([]);
  });
});

describe("ids and output", () => {
  it("two different definitions with one id is an error", async () => {
    const a = rule({ id: "same", title: "a", origin: s1, text: "a", appliesTo: "x", verify: reviewed, evidence: "human" });
    const b = rule({ id: "same", title: "b", origin: s1, text: "b", appliesTo: "x", verify: reviewed, evidence: "human" });
    const r = await compile([a, b], { today, ctx: fakeCtx() });
    expect(r.issues.some((i) => i.rule === "id")).toBe(true);
  });

  it("prints a single line when everything is green", async () => {
    const r1 = rule({ id: "r", title: "r", origin: s1, text: "English commits", appliesTo: "git", verify: reviewed, evidence: "human" });
    const r = await compile([r1], { today, ctx: fakeCtx() });
    expect(formatCheck(r)).toBe("✓ 2 definitions · 1 tests · 100% · 0 parked");
  });
});
