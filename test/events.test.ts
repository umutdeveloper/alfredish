import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/compiler.ts";
import { nodeContext } from "../src/context.ts";
import { event, session } from "../src/dsl.ts";
import { checkNewEvents } from "../src/repo.ts";
import { snapshot } from "../src/snapshot.ts";
import { shapeProblems } from "../src/validate.ts";
import type { EventDef } from "../src/types.ts";

const s1 = session({ id: "s.2026-07-21", title: "s", at: "2026-07-21", topic: "t", questions: ["?"] });
const s2 = session({ id: "s.2026-10-05", title: "s", at: "2026-10-05", topic: "t", questions: ["?"] });
const fivePerWeek = event({ id: "e.fivePerWeek", title: "Five videos a week", origin: s1, at: "2026-07-21", text: "The calendar was set to five videos a week, Monday to Friday at 20:30, weekends off, each video on all three platforms." });
const offline = event({ id: "e.alfredLocal", title: "Alfred disconnected from GitHub", origin: s1, at: "2026-07-21", text: "Alfred's repository remote was removed; Alfred lives only on this Mac and can be carried as one folder." });
const old = [fivePerWeek, offline];

async function repo() {
  const base = await mkdtemp(join(tmpdir(), "alfredish-events-"));
  await mkdir(join(base, "memory"));
  return { base, memoryDir: "memory", ctx: nodeContext(base) };
}
/** Only `added` is new: the old events are in the reference (the last signed state). */
const check = async (added: EventDef, embedFail = false) =>
  checkNewEvents(collect([...old, added]).defs, await repo(), embedFail ? () => Promise.reject(new Error("model file altered")) : undefined, snapshot(collect(old).defs));

const retold = (extra: Partial<EventDef> = {}) =>
  event({ id: "e.postingWeekdays", title: "Posting schedule moved to five videos weekly", origin: s2, at: "2026-07-21", text: "From now on a video goes out every weekday evening at 20:30 on TikTok, Reels and Shorts; nothing is posted at weekends.", ...extra });

describe("K29 — a new event must be compared with every event (real model)", () => {
  it("a retelling of a recorded happening is red and names the event with its score", async () => {
    const issues = await check(retold());
    expect(issues).toEqual([expect.objectContaining({ id: "e.postingWeekdays", rule: "K29", message: expect.stringMatching(/new event is close to: e\.fivePerWeek \(0\.\d\d\) — if it tells the same happening, do not add it/) })]);
    expect(issues[0]!.message).not.toContain("e.alfredLocal");
  }, 60_000);

  it("passes once decided: another happening (distinctFrom) or a correction (corrects)", async () => {
    expect(await check(retold({ distinctFrom: [fivePerWeek] }))).toEqual([]);
    expect(await check(retold({ corrects: fivePerWeek }))).toEqual([]);
  }, 60_000);

  it("an unrelated event passes without any decision", async () => {
    const other = event({ id: "e.mortgage", title: "Mortgage instalment unchanged", origin: s2, at: "2026-10-05", text: "The bank confirmed the monthly mortgage instalment stays at 22,184.94 TL." });
    expect(await check(other)).toEqual([]);
  }, 60_000);

  it("if the model cannot be used, every new event is red — it never passes unseen", async () => {
    expect(await check(retold(), true)).toEqual([expect.objectContaining({ id: "e.postingWeekdays", rule: "K29", message: "cannot compare events: model file altered" })]);
  });

  it("distinctFrom lists events and corrects names an event (K16)", () => {
    expect(shapeProblems({ ...retold(), distinctFrom: ["e.fivePerWeek"] })).toContain("distinctFrom must be a list of events");
    expect(shapeProblems({ ...retold(), corrects: s1 })).toContain("corrects must be an event");
  });
});
