import { describe, it, expect } from "vitest";
import { collect } from "../src/compiler.ts";
import { file, local, promise, session } from "../src/dsl.ts";
import { checkApproval } from "../src/owner.ts";
import { snapshot } from "../src/snapshot.ts";
import type { ApprovedState } from "../src/approval.ts";

// K26: a path the agent marks as confirmed by the owner counts only once the owner signs it — in a test too.
const s = session({ id: "s.2026-10-05", title: "s", at: "2026-10-05", topic: "t", questions: ["?"], changes: { "promise.moveAda": "next step" } });
const where = local("/Users/someone/memories/ada/memory/index.ts", { confirmedBy: "owner", at: "2026-10-05" });
const moveAda = (due: "2026-10-19" | "2026-10-26") => promise({ id: "promise.moveAda", title: "Move Ada", origin: s, owner: "agent", due, requires: [], doneWhen: file(where).exists(), evidence: "live" });
const state = (items: ReturnType<typeof snapshot>): ApprovedState => ({ records: 1, last: undefined, items: new Map(Object.entries(items).map(([k, v]) => [k, v])), rejected: new Map(), corrections: new Map() });

describe("K26 — a local() path inside a test", () => {
  it("is red until the owner signs it, like a local() location", () => {
    const { defs } = collect([moveAda("2026-10-19")]);
    const issues = checkApproval(snapshot(defs), defs, state({}));
    expect(issues).toContainEqual(expect.objectContaining({ id: "promise.moveAda", status: "red", message: expect.stringContaining("a local() path the owner has not signed (in its test)") }));
  });

  it("once signed, another change to the definition is only unapproved — the signed path stays signed", () => {
    const signed = collect([moveAda("2026-10-19")]).defs;
    const { defs } = collect([moveAda("2026-10-26")]);
    const issues = checkApproval(snapshot(defs), defs, state(snapshot(signed))).filter((i) => i.id === "promise.moveAda");
    expect(issues).toEqual([expect.objectContaining({ status: "yellow", message: expect.stringContaining("unapproved: next step") })]);
  });
});
