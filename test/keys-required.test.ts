import { describe, it, expect } from "vitest";
import { compile, collect } from "../src/compiler.ts";
import { checkResearchKeys } from "../src/repo.ts";
import { decision, finding, key, research, session } from "../src/dsl.ts";
import { snapshot } from "../src/snapshot.ts";
import { fakeCtx, reviewed } from "./helpers.ts";

// promise.alfred.keysMandatory: once every memory was keyed, a definition that says no question is red, so repeats
// cannot pile up unseen again.
const today = "2026-10-06" as const;
const s = session({ id: "s.2026-10-06", title: "s", at: today, topic: "t", questions: ["?"] });
const k = key({ subject: "site", name: "hosting", valueType: "text", describe: "where the site is hosted", origin: s });
const dec = (extra: object = {}) => decision({ id: "d.host", title: "Host on Cloudflare Pages", origin: s, restsOn: [], review: "90d", verify: reviewed, evidence: "human", ...extra });

describe("K22 — every decision, rule, promise, goal, idea, asset, account and claim names its key", () => {
  it("one without a key is red and says what to do; with one it is not", async () => {
    const red = (await compile([dec()], { today, ctx: fakeCtx() })).issues.filter((i) => i.rule === "K22");
    expect(red).toEqual([expect.objectContaining({ id: "d.host", status: "red", message: "decision names no key — give it the key of the question it answers (alfred keys --like \"<question>\" finds an existing one)" })]);
    expect((await compile([dec({ key: k })], { today, ctx: fakeCtx() })).issues.filter((i) => i.rule === "K22")).toEqual([]);
  });

  it("a research needs its key only when it is new: a past one cannot change (K5)", () => {
    const r = (id: string, extra: object = {}) => research({ id, title: id, origin: s, at: today, question: "Where?", readWhen: "x", rawData: [], findings: { f: finding({ text: "t" }) }, ...extra });
    const signed = snapshot(collect([r("research.old")]).defs);
    const now = snapshot(collect([r("research.old"), r("research.new"), r("research.keyed", { key: k })]).defs);
    expect(checkResearchKeys(now, signed).map((i) => `${i.id}: ${i.message}`)).toEqual([
      "research.new: a new research names no key — give it the key of the question it answers",
    ]);
  });
});
