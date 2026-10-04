import { describe, it, expect } from "vitest";
import { compile, collect } from "../src/compiler.ts";
import { decision, event, retired, session } from "../src/dsl.ts";
import { snapshot } from "../src/snapshot.ts";
import type { Def, RetiredRef } from "../src/types.ts";
import { fakeCtx, reviewed, s1 } from "./helpers.ts";

const today = "2026-10-05" as const;
const s2 = session({ id: "s.2026-10-05", title: "today", at: today, topic: "merge", questions: ["?"] });
const kept = decision({ id: "d.kept", title: "Kept", origin: s1, restsOn: [], review: "90d", verify: reviewed, evidence: "human" });
const old = decision({ id: "d.old", title: "Old", origin: s1, restsOn: [], review: "90d", verify: reviewed, evidence: "human" });
const past = (affects: readonly (Def | RetiredRef)[]) => event({ id: "e.past", title: "Past", origin: s1, at: "2026-10-01", text: "It happened.", affects });
const merged = event({ id: "e.merged", title: "Merged", origin: s2, at: today, text: "d.old repeated d.kept.", affects: [kept], retires: ["d.old"] });
const k20 = async (roots: unknown[]) => (await compile(roots, { today, ctx: fakeCtx() })).issues.filter((i) => i.rule === "K20");

describe("K20 — a past event names a retired definition with retired(id), and stays as it was (K5)", () => {
  it("serialises exactly like the live reference did, so the past event's record does not change", () => {
    const before = snapshot(collect([past([old])]).defs)["e.past"];
    const after = snapshot(collect([past([retired("d.old")]), merged]).defs)["e.past"];
    expect(after).toEqual(before);
  });

  it("is accepted when an event retires that id and it is gone", async () => {
    expect(await k20([past([retired("d.old")]), merged])).toEqual([]);
  });

  it("is red when nothing retired it, or when the definition still exists", async () => {
    expect(await k20([past([retired("d.old")]), kept])).toEqual([expect.objectContaining({ id: "e.past", message: expect.stringContaining('retired("d.old") but no event retires it') })]);
    expect(await k20([past([retired("d.old")]), old, merged])).toEqual([expect.objectContaining({ id: "e.past", message: expect.stringContaining('retired("d.old") but d.old still exists') })]);
  });
});
