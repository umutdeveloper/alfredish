import { describe, it, expect } from "vitest";
import { checkLocalPaths, MUST_CATCH, MUST_PASS, namesMachinePath } from "../src/paths.ts";
import { file, local, promise, session } from "../src/dsl.ts";
import { collect } from "../src/compiler.ts";
import { snapshot } from "../src/snapshot.ts";
import { confirmedPaths } from "../src/paths.ts";
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

describe("K30 — a confirmed path inside a test", () => {
  it("file(local(...)) in a promise's test counts as confirmed, though the record keeps only the description", () => {
    const s = session({ id: "s", title: "s", at: "2026-10-05", topic: "t", questions: ["?"] });
    const where = local("/Users/someone/memories/ada/memory/index.ts", { confirmedBy: "owner", at: "2026-10-05" });
    const p = promise({ id: "promise.moveAda", title: "Move Ada", origin: s, owner: "agent", due: "2026-10-19", requires: [], doneWhen: file(where).exists(), evidence: "live" });
    const { defs } = collect([p]);
    expect(checkLocalPaths(snapshot(defs)).map((i) => i.id)).toEqual(["promise.moveAda"]); // without the definitions
    expect(checkLocalPaths(snapshot(defs), confirmedPaths(defs))).toEqual([]);
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
