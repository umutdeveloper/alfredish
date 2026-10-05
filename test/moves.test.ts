import { describe, it, expect } from "vitest";
import { checkHistory, checkPast } from "../src/repo.ts";
import { approveBlockers, changesSince, TOOL_SRC } from "../src/approve.ts";
import type { ApprovedState } from "../src/approval.ts";
import type { Snapshot } from "../src/snapshot.ts";
import type { ProbeContext } from "../src/types.ts";
import { fakeCtx } from "./helpers.ts";

// Eşik leaves Alfred: its past event, its asset and its key are gone here, and an event of today says where they went.
const today = "2026-10-05" as const;
const item = (kind: string, hash: string, data: Record<string, unknown>) => ({ kind, hash, data });
const before: Snapshot = {
  "event.esik.started": item("event", "h1", { at: "2026-09-29", title: "Eşik started" }),
  "project.esik": item("asset", "h2", { title: "Eşik repo" }),
  "key:esikDoor.width": item("key", "h3", { describe: "door width" }),
};
const moveEvent = item("event", "h4", { at: today, title: "Eşik moved", moves: { memory: "esik", ids: Object.keys(before) } });
const after: Snapshot = { "event.2026-10-05.esikMoved": moveEvent };
const signedThere = (missing: string[] = []): ProbeContext => ({
  ...fakeCtx(),
  signed: async (memory, id) => (memory === "esik" && !missing.includes(id) ? { hash: "x", data: {} } : { why: `not in ${memory}'s signed state` }),
});
const o = (ctx: ProbeContext) => ({ base: "/nowhere", memoryDir: "memory", ctx });
const rules = async (snap: Snapshot, ctx: ProbeContext) => [...(await checkPast(snap, today, o(ctx), before)), ...(await checkHistory(snap, today, o(ctx), before))].map((i) => `${i.rule} ${i.id}: ${i.message}`);

describe("moving definitions into another memory (K5, K20)", () => {
  it("they may leave — past records too — when the other memory's owner-signed state holds them", async () => {
    expect(await rules(after, signedThere())).toEqual([]);
  });

  it("one the other memory has not signed may not leave yet", async () => {
    expect(await rules(after, signedThere(["event.esik.started"]))).toEqual([
      "K5 event.esik.started: moved to esik, but not in esik's signed state — the owner approves it there first",
    ]);
  });

  it("without the move, removing them is red as before — a key now included", async () => {
    expect(await rules({}, signedThere())).toEqual([
      "K5 event.esik.started: past deleted (2026-09-29)",
      'K20 project.esik: removed since the last commit — record it in an event dated 2026-10-05 with retires: ["project.esik"] and say why',
      'K20 key:esikDoor.width: removed since the last commit — record it in an event dated 2026-10-05 with retires: ["key:esikDoor.width"] and say why',
    ]);
  });

  it("alfred approve offers a moved past record for removal, never one that did not move", async () => {
    const state: ApprovedState = { records: 1, last: undefined, items: new Map(Object.entries(before)), rejected: new Map(), corrections: new Map() };
    const changes = changesSince(state, after);
    const base = "/nowhere";
    const past = (b: { message: string }[]) => b.filter((x) => x.message.includes("past record"));
    expect(past(await approveBlockers({ base, invalid: [], changes, toolSrc: TOOL_SRC, moved: new Set(["event.esik.started"]) }))).toEqual([]);
    expect(past(await approveBlockers({ base, invalid: [], changes, toolSrc: TOOL_SRC }))).toHaveLength(1);
  });
});
