import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/compiler.ts";
import { nodeContext } from "../src/context.ts";
import { fact, key, review, session } from "../src/dsl.ts";
import { checkNewKeys } from "../src/repo.ts";
import { shapeProblems } from "../src/validate.ts";
import { fakeCtx } from "./helpers.ts";

const s1 = session({ id: "s.2026-10-01", title: "t", at: "2026-10-01", topic: "t", questions: ["?"] });
const ok = review({ by: "owner", at: "2026-10-01", every: "90d" });
const budgetCap = key({ subject: "ada", name: "budgetCap", valueType: "amount", describe: "monthly spending ceiling", origin: s1 });
const launchDate = key({ subject: "ada", name: "launchDate", valueType: "date", describe: "day the product goes public", origin: s1 });
const city = key({ subject: "umut", name: "city", valueType: "text", describe: "city the person lives in", origin: s1 });

async function repo() {
  const base = await mkdtemp(join(tmpdir(), "alfredish-keys-")); // no git: every key counts as new
  await mkdir(join(base, "memory"));
  return { base, memoryDir: "memory", ctx: nodeContext(base) };
}

describe("key — shape (K16)", () => {
  it("a key built with key() is well-formed; a broken one names the field", () => {
    expect(shapeProblems(budgetCap)).toEqual([]);
    expect(shapeProblems({ ...budgetCap, subject: "Ada" }).join()).toContain("subject must be a lowerCamelCase name");
    expect(shapeProblems({ ...budgetCap, valueType: "money" }).join()).toContain("valueType must be");
    expect(shapeProblems({ ...fact({ id: "f", title: "t", origin: s1, value: 1, verify: ok, evidence: "human" }), key: "ada.budgetCap" }).join()).toContain("key is not a key");
  });
});

describe("K22 — one value per property", () => {
  it("two present facts with the same key are red; one is fine", async () => {
    const f1 = fact({ id: "f.cap1", title: "Cap", origin: s1, value: "15000 TL", key: budgetCap, verify: ok, evidence: "human" });
    const f2 = fact({ id: "f.cap2", title: "Cap", origin: s1, value: "20000 TL", key: budgetCap, verify: ok, evidence: "human" });
    const one = await compile([f1], { today: "2026-10-02", ctx: fakeCtx() });
    expect(one.issues.filter((i) => i.rule === "K22")).toEqual([]);
    const two = await compile([f1, f2], { today: "2026-10-02", ctx: fakeCtx() });
    expect(two.issues).toContainEqual(expect.objectContaining({ id: "f.cap2", rule: "K22", message: expect.stringContaining("two values for key:ada.budgetCap: f.cap1, f.cap2") }));
  });
});

describe("K24 — a key is one property", () => {
  it("a catch-all name is red", async () => {
    const summary = key({ subject: "realtyme", name: "employerSummary", valueType: "text", describe: "about the employer", origin: s1 });
    const r = await compile([summary], { today: "2026-10-02", ctx: fakeCtx() });
    expect(r.issues).toContainEqual(expect.objectContaining({ id: "key:realtyme.employerSummary", rule: "K24" }));
    const rate = key({ subject: "supabaseApps", name: "dataExposureRate", valueType: "number", describe: "share of apps exposing data", origin: s1 });
    const ok = await compile([rate], { today: "2026-10-02", ctx: fakeCtx() });
    expect(ok.issues.filter((i) => i.rule === "K24")).toEqual([]); // "data" is not the head word: a rate is one property
  });
});

describe("K23 — a new key must be compared with the existing ones (real model)", () => {
  it("a renamed duplicate is red and names the existing key with its score", async () => {
    const monthlyLimit = key({ subject: "ada", name: "monthlyLimit", valueType: "amount", describe: "most money spent in a month", origin: s1 });
    const issues = await checkNewKeys([budgetCap, launchDate, monthlyLimit], await repo());
    const mine = issues.find((i) => i.id === "key:ada.monthlyLimit");
    expect(mine?.rule).toBe("K23");
    expect(mine?.message).toMatch(/new key is close to: key:ada\.budgetCap \(0\.8\d\)/);
    expect(mine?.message).not.toContain("key:ada.launchDate"); // unrelated, below the threshold
  }, 60_000);

  it("a close but different property passes once the decision is written in distinctFrom", async () => {
    const hometown = key({ subject: "umut", name: "hometown", valueType: "text", describe: "town the person grew up in", origin: s1 });
    expect((await checkNewKeys([city, hometown], await repo())).map((i) => i.id)).toContain("key:umut.hometown");
    const decided = key({ ...hometown, distinctFrom: [city] }); // decided once, from one side: enough for both
    expect(await checkNewKeys([city, decided], await repo())).toEqual([]);
  }, 60_000);

  it("if the model cannot be used, every new key is red — it never passes unseen", async () => {
    const issues = await checkNewKeys([budgetCap], await repo(), () => Promise.reject(new Error("model file altered")));
    expect(issues).toEqual([expect.objectContaining({ id: "key:ada.budgetCap", rule: "K23", message: "cannot compare keys: model file altered" })]);
  });
});
