import { describe, it, expect } from "vitest";
import { checkLocalPaths, MUST_CATCH, MUST_PASS, namesMachinePath } from "../src/paths.ts";
import { file, local } from "../src/dsl.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { fakeCtx } from "./helpers.ts";

const item = (kind: string, data: Record<string, unknown>) => ({ kind, hash: "h", data });

describe("K30 — no machine path in a memory's text", () => {
  it("proves itself first: every known path form is caught, ordinary text is not", () => {
    expect(MUST_CATCH.filter((s) => !namesMachinePath(s))).toEqual([]);
    expect(MUST_PASS.filter(namesMachinePath)).toEqual([]);
  });

  it("a path in a title or a decision is red, wherever it hides", () => {
    const snap: Snapshot = {
      "d.split": item("decision", { title: "RealTyme stays until ~/rt is restructured" }),
      "e.note": item("event", { text: "Moved", affects: ["@x"], notes: { where: ["see ../../ada/memory"] } }),
    };
    expect(checkLocalPaths(snap).map((i) => `${i.id} ${i.message.split(" (")[0]}`)).toEqual([
      "d.split title names a path on one machine",
      "e.note notes.where[0] names a path on one machine",
    ]);
  });

  it("a confirmed local() path may appear in a test's description, never in free text", () => {
    const where = local("/Users/someone/.alfredish/memories.json", { confirmedBy: "owner", at: "2026-10-05" });
    const ok: Snapshot = { "a.reg": item("asset", { title: "The memories registry", location: where, verify: `file ${where.path} contains "alfred"` }) };
    expect(checkLocalPaths(ok)).toEqual([]);
    const bad: Snapshot = { "a.reg": item("asset", { title: `Registry at ${where.path}`, location: where, verify: "review by owner" }) };
    expect(checkLocalPaths(bad).map((i) => i.id)).toEqual(["a.reg"]);
  });
});

describe("file(path).contains(text)", () => {
  it("reads the file and is red when the text is missing or the file cannot be read", async () => {
    const ctx = { ...fakeCtx(), readText: async (p: string) => (p === "reg.json" ? '{ "alfred": "x", "esik": "y" }' : undefined) };
    expect(await file("reg.json").contains('"esik"').run(ctx)).toEqual({ ok: true });
    expect((await file("reg.json").contains('"ada"').run(ctx)).ok).toBe(false);
    expect(await file("gone.json").contains('"esik"').run(ctx)).toEqual({ ok: false, detail: "cannot be read" });
  });
});
