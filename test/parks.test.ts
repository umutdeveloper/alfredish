import { describe, it, expect } from "vitest";
import { compile } from "../src/compiler.ts";
import { decision, event, fact, finding, fromFinding, key, research, session } from "../src/dsl.ts";
import { shapeProblems } from "../src/validate.ts";
import type { Def } from "../src/types.ts";
import { fakeCtx, reviewed } from "./helpers.ts";

// A past research served two memories; one of them now has its own research, so two findings support nothing here.
// The research cannot change (K5); an event of today parks the findings (K12).
const today = "2026-10-05" as const;
const s1 = session({ id: "s.2026-10-01", title: "s", at: "2026-10-01", topic: "t", questions: ["?"] });
const s2 = session({ id: "s.2026-10-05", title: "s", at: today, topic: "t", questions: ["?"] });
const profile = research({ id: "research.profile", title: "Profile", origin: s1, at: "2026-10-01", question: "Who?", readWhen: "always", rawData: [],
  findings: { linkedin: finding({ text: "LinkedIn: 972 followers" }), jira: finding({ text: "Jira: 1,226 issues" }) } });
const kFollowers = key({ subject: "umut", name: "linkedinFollowers", valueType: "number", describe: "LinkedIn followers", origin: s1 });
const followers = fact({ id: "self.linkedin", key: kFollowers, title: "LinkedIn followers", origin: s1, value: "972", verify: fromFinding(profile.findings.linkedin!, { ttl: "365d" }), evidence: "research" });
const onIt = decision({ id: "d.visible", title: "Be more visible", origin: s1, restsOn: [followers], review: "90d", verify: reviewed, evidence: "human" });
const parks = (p: Record<string, string>) => event({ id: "e.2026-10-05.parked", title: "Work evidence moved", origin: s2, at: today, text: "RealTyme measured its own evidence.", parks: p });
const k12 = async (defs: Def[]) => (await compile(defs, { today, ctx: fakeCtx() })).issues.filter((i) => i.rule === "K12").map((i) => `${i.id}: ${i.message}`);

describe("K12 — an event parks findings of a past research that support nothing any more", () => {
  it("unparked, the unused finding is red; parked by an event, it is not, and the research is unchanged", async () => {
    expect(await k12([onIt, profile])).toEqual(["research.profile#jira: finding unused and not parked"]);
    expect(await k12([onIt, profile, parks({ "research.profile#jira": "RealTyme now rests on its own research" })])).toEqual([]);
  });

  it("is red for a finding that does not exist, or one that still supports something here", async () => {
    expect(await k12([onIt, profile, parks({ "research.profile#jira": "moved", "research.profile#nope": "typo" })])).toEqual(["e.2026-10-05.parked: parks research.profile#nope, which is no finding of a research here"]);
    expect(await k12([onIt, profile, parks({ "research.profile#jira": "moved", "research.profile#linkedin": "wrong" })])).toEqual([
      "research.profile#linkedin: parked by e.2026-10-05.parked, but it still supports something here — take it out of parks",
    ]);
  });

  it("maps \"<research>#<finding>\" to a reason (K16)", () => {
    expect(shapeProblems({ ...parks({}), parks: { "research.profile": "no finding" } })).toContain('parks must map "<research id>#<finding>" to a reason');
    expect(shapeProblems({ ...parks({}), parks: { "research.profile#jira": "" } })).toContain('parks must map "<research id>#<finding>" to a reason');
  });
});
