import { describe, it, expect } from "vitest";
import { compile } from "../src/compiler.ts";
import { confirm, decision, finding, goal, idea, key, promise, research, rule, session } from "../src/dsl.ts";
import { changesSince } from "../src/approve.ts";
import { entriesFor } from "../src/approve-screen.ts";
import { snapshot } from "../src/snapshot.ts";
import { collect } from "../src/compiler.ts";
import { shapeProblems } from "../src/validate.ts";
import type { Def } from "../src/types.ts";
import { fakeCtx, reviewed } from "./helpers.ts";

// Keys spread from facts to the other kinds (alfredish.keysForEveryKind): the key is the question a definition answers,
// and K22 makes two answers to one question visible — unless the later one names the earlier (supersedes, renews, repeats).
const today = "2026-10-05" as const;
const s = session({ id: "s.2026-10-05", title: "s", at: today, topic: "t", questions: ["?"] });
const kCeiling = key({ subject: "ada", name: "monthlySpendCeiling", valueType: "amount", describe: "most Ada may spend in a month", origin: s });
const kRenewal = key({ subject: "umutcakirCom", name: "renewal", valueType: "date", describe: "when the domain is renewed", origin: s });
const kVisibility = key({ subject: "golive", name: "aiVisibility", valueType: "text", describe: "AI answers that name us", origin: s });
const dec = (id: string, extra: object = {}) => decision({ id, title: id, origin: s, restsOn: [], review: "90d", verify: reviewed, evidence: "human", key: kCeiling, ...extra });
const k22 = async (defs: unknown[]) => (await compile(defs, { today, ctx: fakeCtx() })).issues.filter((i) => i.rule === "K22").map((i) => `${i.id}: ${i.message}`);

describe("K22 for every kind that names a key", () => {
  it("two decisions on one question are red; one that supersedes the other is not", async () => {
    const a = dec("d.ceiling15k");
    expect(await k22([a, dec("d.ceiling20k")])).toEqual([
      "d.ceiling15k: two decisions for key:ada.monthlySpendCeiling: d.ceiling15k, d.ceiling20k — change the existing one, retire one (K20), or name the earlier in supersedes",
      "d.ceiling20k: two decisions for key:ada.monthlySpendCeiling: d.ceiling15k, d.ceiling20k — change the existing one, retire one (K20), or name the earlier in supersedes",
    ]);
    expect(await k22([a, dec("d.ceiling20k", { supersedes: a })])).toEqual([]);
  });

  it("different kinds may share a question on purpose (a rule serving its decision)", async () => {
    const r = rule({ id: "rule.ada.budgetCap", title: "Budget cap", origin: s, appliesTo: "ada", text: "At most 15,000 TL a month.", verify: reviewed, evidence: "human", key: kCeiling });
    expect(await k22([dec("d.ceiling15k"), r])).toEqual([]);
  });

  it("a promise that renews a done one may share its key; two open ones, or a renewal that does not name it, are red", async () => {
    const y2026 = promise({ id: "p.renew2026", title: "Renew 2026", origin: s, owner: "owner", due: "2026-07-01", requires: [], doneWhen: confirm({ by: "owner", what: "renewed", at: "2026-06-30" }), evidence: "human", key: kRenewal });
    const y2027 = (extra: object = {}) => promise({ id: "p.renew2027", title: "Renew 2027", origin: s, owner: "owner", due: "2027-07-01", requires: [], doneWhen: confirm({ by: "owner", what: "renewed" }), evidence: "human", key: kRenewal, ...extra });
    expect(await k22([y2026, y2027({ renews: y2026 })])).toEqual([]);
    expect(await k22([y2026, y2027()])).toEqual([
      "p.renew2026: two promises for key:umutcakirCom.renewal: p.renew2026, p.renew2027 — change the existing one, retire one (K20), or name the earlier in renews",
      "p.renew2027: two promises for key:umutcakirCom.renewal: p.renew2026, p.renew2027 — change the existing one, retire one (K20), or name the earlier in renews",
    ]);
    const open2026 = { ...y2026, verify: confirm({ by: "owner", what: "renewed" }) };
    expect(await k22([open2026, y2027({ renews: open2026 })])).toEqual([
      "p.renew2026: two open promises for key:umutcakirCom.renewal: p.renew2026, p.renew2027 — only one may be open; finish the earlier one first",
      "p.renew2027: two open promises for key:umutcakirCom.renewal: p.renew2026, p.renew2027 — only one may be open; finish the earlier one first",
    ]);
  });

  it("goals renew like promises", async () => {
    const g = (id: string, done: boolean, extra: object = {}) => goal({ id, title: id, origin: s, phase: { name: "p", ends: "2026-12-31" }, requires: [], doneWhen: confirm({ by: "owner", what: "done", ...(done && { at: today }) }), evidence: "human", key: kVisibility, ...extra });
    const first = g("g.first", true);
    expect(await k22([first, g("g.second", false, { renews: first })])).toEqual([]);
    expect(await k22([first, g("g.second", false)])).toHaveLength(2);
  });

  it("a research that repeats another may share its question; one that does not name it is red", async () => {
    const r = (id: string, extra: object = {}) => research({ id, title: id, origin: s, at: today, question: "Does AI name us?", readWhen: "visibility", rawData: [], findings: { f: finding({ text: "not yet", parked: { reason: "context", revisitWhen: confirm({ by: "owner", what: "x" }) } }) }, key: kVisibility, ...extra });
    const first = r("research.visibility1");
    expect(await k22([first, r("research.visibility2", { repeats: first })])).toEqual([]);
    expect(await k22([first, r("research.visibility2")])).toEqual([
      "research.visibility1: two researchs for key:golive.aiVisibility: research.visibility1, research.visibility2 — change the existing one, retire one (K20), or name the earlier in repeats",
      "research.visibility2: two researchs for key:golive.aiVisibility: research.visibility1, research.visibility2 — change the existing one, retire one (K20), or name the earlier in repeats",
    ].map((m) => m.replace("researchs", "research records")));
  });

  it("two ideas on one question are red (no exception)", async () => {
    const i = (id: string) => idea({ id, title: id, origin: s, text: "t", reason: "r", revisitWhen: confirm({ by: "owner", what: "x" }), evidence: "human", key: kCeiling });
    expect(await k22([i("idea.a"), i("idea.b")])).toHaveLength(2);
  });

  it("the key, renews and repeats are well-formed (K16) and recorded by reference", () => {
    expect(shapeProblems({ ...dec("d.x"), key: "key:ada.monthlySpendCeiling" })).toContain("key must be a key — build it with key()");
    const p = promise({ id: "p.a", title: "a", origin: s, owner: "owner", due: today, requires: [], doneWhen: confirm({ by: "owner", what: "x" }), evidence: "human" });
    expect(shapeProblems({ ...p, renews: dec("d.x") })).toContain("renews must be a promise");
    expect(snapshot(collect([dec("d.x")]).defs)["d.x"]!.data["key"]).toBe("@key:ada.monthlySpendCeiling");
  });
});

describe("§14 the new keys come as one step", () => {
  it("lists every new key with its question and distinctFrom, approve all or look one by one", () => {
    const k2 = key({ subject: "ada", name: "parentReport", valueType: "text", describe: "what parents get each week", origin: s, distinctFrom: [kCeiling] });
    const after = snapshot(collect([kCeiling, k2]).defs);
    const changes = changesSince(undefined, after).filter((c) => c.kind === "key");
    const e = entriesFor(changes, { firstRound: false }).find((x) => x.key === "__keys")!;
    expect(e.title).toBe("2 new keys");
    expect(e.buttons).toEqual(["approveGroup", "startOne"]);
    expect(e.members).toEqual(["key:ada.monthlySpendCeiling", "key:ada.parentReport"]);
    const text = e.lines.join("\n");
    expect(text).toContain("most Ada may spend in a month");
    expect(text).toContain("distinctFrom");
  });
});

export type _ = Def;
