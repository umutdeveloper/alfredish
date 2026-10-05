import { describe, it, expect } from "vitest";
import { checkApproval, latestReasons } from "../src/owner.ts";
import { changesSince } from "../src/approve.ts";
import type { ApprovedState } from "../src/approval.ts";
import type { Snapshot } from "../src/snapshot.ts";

// §14: the reason the owner reads is the latest one. Two sessions of one day once ranked by their ids, so a morning
// session's old reason could hide the evening's new one (seen 2026-10-05: "esikRules" sorts after "esikRelink").
const item = (kind: string, hash: string, data: Record<string, unknown>) => ({ kind, hash, data });
const morning = item("session", "s1", { at: "2026-10-05", changes: { "link.x": "linked so the agent follows it" } });
const evening = item("session", "s2", { at: "2026-10-05", changes: { "link.x": "the rule changed; linked to the new wording" } });
const linkOld = item("link", "l1", { title: "x" });
const linkNew = item("link", "l2", { title: "x" });
const state = (items: Snapshot): ApprovedState => ({ records: 1, last: undefined, items: new Map(Object.entries(items)), rejected: new Map(), corrections: new Map() });

describe("§14 the latest reason: by day, then a signed unchanged session before a new or changed one", () => {
  it("the new session's reason wins over the signed morning's, whatever their ids", () => {
    const signed = { "s.2026-10-05.esikRules": morning, "link.x": linkOld };
    const snap: Snapshot = { "s.2026-10-05.esikRelink": evening, "s.2026-10-05.esikRules": morning, "link.x": linkNew };
    expect(latestReasons(snap, state(signed)).why.get("link.x")).toBe("the rule changed; linked to the new wording");
    expect(changesSince(state(signed), snap).find((c) => c.id === "link.x")?.why).toBe("the rule changed; linked to the new wording");
    expect(checkApproval(snap, [], state(signed)).filter((i) => i.id === "link.x").map((i) => i.status)).toEqual(["yellow"]);
  });

  it("two new sessions of one day giving a reason for the same id is red: keep it in one", () => {
    const snap: Snapshot = { "s.2026-10-05.a": morning, "s.2026-10-05.b": evening, "link.x": linkNew };
    expect(checkApproval(snap, [], state({ "link.x": linkOld }))).toContainEqual(expect.objectContaining({
      id: "link.x", status: "red", rule: "K26", message: "two of 2026-10-05's sessions not yet signed give a reason (s.2026-10-05.a, s.2026-10-05.b) — keep it in one, so the owner reads the right one",
    }));
  });

  it("an earlier day still comes first", () => {
    const yesterday = item("session", "s0", { at: "2026-10-04", changes: { "link.x": "yesterday" } });
    const snap: Snapshot = { "s.2026-10-05.z": evening, "s.2026-10-04.a": yesterday, "link.x": linkNew };
    expect(latestReasons(snap, state({ "link.x": linkOld })).why.get("link.x")).toBe("the rule changed; linked to the new wording");
  });
});
