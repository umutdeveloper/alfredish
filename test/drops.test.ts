import { describe, it, expect } from "vitest";
import { collect, compile } from "../src/compiler.ts";
import { checkDrops, checkPast, droppedIds } from "../src/repo.ts";
import { approveBlockers, changesSince, TOOL_SRC } from "../src/approve.ts";
import { entriesFor } from "../src/approve-screen.ts";
import type { ApprovedState } from "../src/approval.ts";
import { event, retired, rule, session } from "../src/dsl.ts";
import { snapshot } from "../src/snapshot.ts";
import { shapeProblems } from "../src/validate.ts";
import type { Def, EventDef } from "../src/types.ts";
import { fakeCtx, reviewed } from "./helpers.ts";

// Two accounts of one happening were signed long ago; today the shorter one leaves as a repeat of the other (K32).
const today = "2026-10-05" as const;
const s1 = session({ id: "s.2026-07-21", title: "s", at: "2026-07-21", topic: "t", questions: ["?"] });
const s2 = session({ id: "s.2026-10-05", title: "s", at: today, topic: "t", questions: ["?"] });
const calendar = rule({ id: "rule.calendar", title: "Calendar", origin: s1, appliesTo: "content", text: "Post on the calendar.", verify: reviewed, evidence: "human" });
const kept = event({ id: "e.fivePerWeek", title: "Five videos a week", origin: s1, at: "2026-07-21", affects: [calendar], text: "The calendar was set to five videos a week, Monday to Friday at 20:30, weekends off, each video on all three platforms." });
const repeat = event({ id: "e.postingWeekdays", title: "Posting schedule moved to five videos weekly", origin: s1, at: "2026-07-21", affects: [calendar], text: "From now on a video goes out every weekday evening at 20:30 on TikTok, Reels and Shorts; nothing is posted at weekends." });
const unrelated = event({ id: "e.mortgage", title: "Mortgage instalment unchanged", origin: s1, at: "2026-07-21", text: "The bank confirmed the monthly mortgage instalment stays at 22,184.94 TL." });
const signed = snapshot(collect([s1, calendar, kept, repeat, unrelated]).defs);

const drop = (drops: { id: string; repeatOf: EventDef }[], extra: Partial<EventDef> = {}) =>
  event({ id: "e.2026-10-05.repeatDropped", title: "A repeat dropped", origin: s2, at: today, text: "The posting-calendar event was told twice; the second account leaves.", drops, ...extra });
const o = { base: "/nowhere", memoryDir: "memory", ctx: fakeCtx() };
const now = (defs: Def[]) => snapshot(collect(defs).defs);
const rules = async (snap: ReturnType<typeof snapshot>, embedFail = false) => [
  ...(await checkPast(snap, today, o, signed)),
  ...(await checkDrops(snap, today, signed, embedFail ? () => Promise.reject(new Error("model file altered")) : undefined)),
].map((i) => `${i.rule} ${i.id}: ${i.message}`);

describe("K32 — a past event that only retold another may leave, once, signed by the owner (real model)", () => {
  it("a repeat dropped in favour of the event it retold passes", async () => {
    expect(await rules(now([s1, s2, calendar, kept, unrelated, drop([{ id: repeat.id, repeatOf: kept }])]))).toEqual([]);
  }, 60_000);

  it("without the drop, deleting it is red as before (K5)", async () => {
    expect(await rules(now([s1, s2, calendar, kept, unrelated]))).toEqual(["K5 e.postingWeekdays: past deleted (2026-07-21)"]);
  }, 60_000);

  it("'repeat' cannot remove an event that tells something else: below the threshold is red", async () => {
    expect(await rules(now([s1, s2, calendar, kept, repeat, drop([{ id: unrelated.id, repeatOf: kept }])]))).toEqual([
      expect.stringMatching(/^K32 e\.mortgage: not a repeat of e\.fivePerWeek \(0\.\d\d < 0\.78\) — only a retelling may be dropped$/),
    ]);
  }, 60_000);

  it("the dropped event must be a signed event that is gone, and the kept one another event", async () => {
    expect(await rules(now([s1, s2, calendar, kept, repeat, unrelated, drop([{ id: repeat.id, repeatOf: kept }])]))).toEqual([
      "K32 e.postingWeekdays: dropped, but it still exists — remove it, or take it out of drops",
    ]);
    expect(await rules(now([s1, s2, calendar, kept, repeat, unrelated, drop([{ id: "e.never", repeatOf: kept }])]))).toEqual([
      "K32 e.never: dropped, but it is not an event of the signed state",
    ]);
    // A session is never dropped: it stays red under K5 as well.
    const sOld = session({ id: "s.2026-07-01", title: "s", at: "2026-07-01", topic: "t", questions: ["?"] });
    const signedWith = { ...signed, ...snapshot([sOld]) };
    const snap = now([s1, s2, calendar, kept, repeat, unrelated, drop([{ id: sOld.id, repeatOf: kept }])]);
    expect([...(await checkPast(snap, today, o, signedWith)), ...(await checkDrops(snap, today, signedWith))].map((i) => `${i.rule} ${i.id}: ${i.message}`)).toEqual([
      "K5 s.2026-07-01: past deleted (2026-07-01)",
      "K32 s.2026-07-01: dropped, but it is not an event of the signed state",
    ]);
  }, 60_000);

  it("what the dropped event affected must stay recorded by the kept event or the dropping one", async () => {
    const bare = event({ ...kept, affects: [] });
    const signedBare = snapshot(collect([s1, calendar, bare, repeat, unrelated]).defs);
    const run = async (defs: Def[]) => (await checkDrops(now(defs), today, signedBare)).map((i) => `${i.rule} ${i.id}: ${i.message}`);
    expect(await run([s1, s2, calendar, bare, unrelated, drop([{ id: repeat.id, repeatOf: bare }])])).toEqual([
      "K32 e.postingWeekdays: it affected rule.calendar, which neither e.fivePerWeek nor e.2026-10-05.repeatDropped affects — add it to the dropping event's affects",
    ]);
    expect(await run([s1, s2, calendar, bare, unrelated, drop([{ id: repeat.id, repeatOf: bare }], { affects: [calendar] })])).toEqual([]);
  }, 60_000);

  it("once the owner signed the drop, the rest of its day stays green", async () => {
    const after = now([s1, s2, calendar, kept, unrelated, drop([{ id: repeat.id, repeatOf: kept }])]);
    const signedAfter = Object.fromEntries(Object.entries(after).filter(([id]) => id !== "e.2026-10-05.repeatDropped"));
    expect(await checkDrops(after, today, { ...signedAfter, ...{ [kept.id]: signed[kept.id]! } }, undefined, new Set([repeat.id]))).toEqual([]);
    // An id that was never signed away is still red: a typo never passes as a drop.
    expect((await checkDrops(now([s1, s2, calendar, kept, repeat, unrelated, drop([{ id: "e.never", repeatOf: kept }])]), today, signed, undefined, new Set([repeat.id]))).map((i) => i.message)).toEqual([
      "dropped, but it is not an event of the signed state",
    ]);
  });

  it("if the model cannot be used, every drop is red — it never passes unseen", async () => {
    expect(await rules(now([s1, s2, calendar, kept, unrelated, drop([{ id: repeat.id, repeatOf: kept }])]), true)).toEqual([
      "K32 e.postingWeekdays: cannot compare events: model file altered",
    ]);
  });

  it("drops lists { id, repeatOf: an event } (K16)", () => {
    expect(shapeProblems({ ...drop([]), drops: [{ id: repeat.id, repeatOf: s1 }] })).toContain("drops must be a list of { id, repeatOf: an event }");
    expect(shapeProblems({ ...drop([]), drops: [repeat.id] })).toContain("drops must be a list of { id, repeatOf: an event }");
  });

  it("a past event names a dropped one with retired(), in affects or distinctFrom", async () => {
    const later = event({ id: "e.later", title: "Later", origin: s1, at: "2026-07-22", text: "Something else.", affects: [retired(repeat.id)], distinctFrom: [retired(repeat.id), kept] });
    const issues = async (defs: Def[]) => (await compile(defs, { today, ctx: fakeCtx() })).issues.filter((i) => i.rule === "K20").map((i) => i.message);
    expect(await issues([s1, s2, calendar, kept, later, drop([{ id: repeat.id, repeatOf: kept }])])).toEqual([]);
    expect(await issues([s1, calendar, kept, later])).toEqual([
      `retired("${repeat.id}") but no event retires it — list it in an event's retires and say why`,
      `retired("${repeat.id}") but no event retires it — list it in an event's retires and say why`,
    ]);
    expect(snapshot([later])[later.id]!.data["distinctFrom"]).toEqual([`@${repeat.id}`, `@${kept.id}`]);
  });

  it("droppedIds lists the drops of today's events only", () => {
    const old = drop([{ id: "e.x", repeatOf: kept }], { id: "e.old", at: "2026-10-04" });
    expect([...droppedIds(now([s1, s2, calendar, kept, old, drop([{ id: repeat.id, repeatOf: kept }])]), today).keys()]).toEqual([repeat.id]);
  });
});

describe("K32 in alfred approve: each drop is its own step, skip first", () => {
  const after = now([s1, s2, calendar, kept, unrelated, drop([{ id: repeat.id, repeatOf: kept }])]);
  const state: ApprovedState = { records: 1, last: undefined, items: new Map(Object.entries(signed)), rejected: new Map(), corrections: new Map() };
  const changes = changesSince(state, after);

  it("a valid drop is offered for removal; any other past removal still blocks the round", async () => {
    const past = (b: { message: string }[]) => b.filter((x) => x.message.includes("past record"));
    const base = "/nowhere";
    expect(past(await approveBlockers({ base, invalid: [], changes, toolSrc: TOOL_SRC, dropped: new Map([[repeat.id, { repeatOf: kept.id, score: 0.9 }]]) }))).toEqual([]);
    expect(past(await approveBlockers({ base, invalid: [], changes, toolSrc: TOOL_SRC }))).toHaveLength(1);
  });

  it("a drop K32 refuses blocks the round with K32's own reason, not a tampering warning", async () => {
    const b = await approveBlockers({ base: "/nowhere", invalid: [], changes, toolSrc: TOOL_SRC, dropIssues: new Map([[repeat.id, "cannot compare events: model file not found"]]) });
    expect(b.map((x) => x.message).filter((m) => m.startsWith(repeat.id))).toEqual([
      `${repeat.id} is dropped as a repeat, but K32 refuses it: cannot compare events: model file not found — nothing is removed until alfred check shows the drop green`,
    ]);
  });

  it("the step shows both events in full and the score, and skip comes first", () => {
    const entries = entriesFor(changes, { firstRound: false, dropped: new Map([[repeat.id, { repeatOf: kept.id, score: 0.91, kept: signed[kept.id]!.data }]]) });
    const e = entries.find((x) => x.key === repeat.id)!;
    expect(e.sub).toBe("event · dropped as a repeat");
    expect(e.buttons).toEqual(["skip", "approveRemoval"]);
    const text = e.lines.join("\n");
    expect(text).toContain(repeat.text);
    expect(text).toContain(`kept: ${kept.id} (0.91)`);
    expect(text).toContain(kept.text);
  });
});
