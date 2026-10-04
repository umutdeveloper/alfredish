// K1, K4, K13, K14, K15 are enforced by the type checker. `npm run check` runs tsc first:
// if any line below stops being a type error, @ts-expect-error itself fails the build.
import { describe, it, expect } from "vitest";
import { account, after, asset, claim, decision, fact, goal, idea, page, promise, review, source, url } from "../src/dsl.ts";
import { s1, tk } from "./helpers.ts";

const researchFact = fact({
  id: "f.research", key: tk("f.research", s1), title: "research fact", origin: s1, value: 1,
  verify: source("https://x", { readAt: "2026-10-01", ttl: "30d" }), evidence: "research",
});
const liveFact = fact({ id: "f.live", key: tk("f.live", s1), title: "live fact", origin: s1, value: 1, verify: page("https://x").contains("1"), evidence: "live" });
const ourPrice = decision({
  id: "d.price", title: "our price", origin: s1, restsOn: [researchFact], review: "60d",
  verify: review({ by: "owner", at: "2026-10-01", every: "60d" }), evidence: "human",
});

export function typeRules() {
  // K1: no verify, no build.
  // @ts-expect-error verify is required
  fact({ id: "a", key: tk("a", s1), title: "a", origin: s1, value: 1, evidence: "live" });

  // K13: no origin, no build.
  // @ts-expect-error origin is required
  fact({ id: "b", key: tk("b", s1), title: "b", value: 1, verify: page("https://x").contains("1"), evidence: "live" });

  // K4: a claim cannot rest on a research-level fact…
  claim({
    id: "c", title: "c", origin: s1, text: "t", where: url("https://x"), evidence: "live", verify: page("https://x").contains("t"),
    // @ts-expect-error a fact behind a claim needs live/source evidence
    restsOn: [researchFact],
  });
  // …but it may rest on a live fact, and on our own decision.
  claim({ id: "d", title: "d", origin: s1, text: "t", where: url("https://x"), evidence: "live", verify: page("https://x").contains("t"), restsOn: [liveFact, ourPrice] });

  // K15: a location is typed — a plain string (which could be a local path) does not compile.
  const acc = account({ id: "acc", title: "a", origin: s1, service: "x", owner: "owner", login: "o", agentAccess: "none", verify: review({ by: "owner", at: "2026-10-01", every: "90d" }), evidence: "human" });
  // @ts-expect-error a location must be url() or local()
  asset({ id: "a1", title: "a", origin: s1, on: acc, desired: "x", location: "~/Projects/site", verify: page("https://x").contains("1"), evidence: "live" });
  asset({ id: "a2", title: "a", origin: s1, on: acc, desired: "x", location: url("https://github.com/o/site"), verify: page("https://x").contains("1"), evidence: "live" });
  // @ts-expect-error claim.where is a location too
  claim({ id: "w", title: "w", origin: s1, text: "t", where: "https://x", evidence: "live", verify: page("https://x").contains("t"), restsOn: [] });

  // K14: goals and promises state their preconditions, even when there are none.
  // @ts-expect-error requires is required
  goal({ id: "g", title: "g", origin: s1, phase: { name: "p", ends: "2026-12-01" }, doneWhen: page("https://x").contains("1"), evidence: "live" });
  goal({ id: "g2", title: "g2", origin: s1, phase: { name: "p", ends: "2026-12-01" }, requires: [], doneWhen: page("https://x").contains("1"), evidence: "live" });

  // Conditions: a revisit/due condition cannot be a freshness check.
  // @ts-expect-error review is not a condition
  idea({ id: "i", title: "i", origin: s1, text: "t", reason: "r", revisitWhen: review({ by: "owner", at: "2026-10-01", every: "30d" }), evidence: "human" });
  idea({ id: "i2", title: "i2", origin: s1, text: "t", reason: "r", revisitWhen: after("2026-12-01"), evidence: "human" });
  promise({ id: "p", title: "p", origin: s1, owner: "owner", due: after("2026-12-01"), requires: [], doneWhen: page("https://x").contains("1"), evidence: "human" });
}

describe("type-level rules", () => {
  it("are checked by tsc (see @ts-expect-error lines)", () => {
    expect(typeof typeRules).toBe("function");
  });
});
