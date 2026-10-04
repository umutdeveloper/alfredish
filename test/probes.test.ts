import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "../src/compiler.ts";
import { areaDefs } from "../src/repo.ts";
import { cmd, decision, fact, review } from "../src/dsl.ts";
import type { PresentDef, ProbeCache, ProbeContext } from "../src/types.ts";
import { s1, tk } from "./helpers.ts";

const today = "2026-10-03" as const;
const now = Date.parse("2026-10-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

/** A context whose commands count their runs; `fail` makes a command exit 1. */
function countingCtx(fail: string[] = [], delayMs = 0) {
  const runs: Record<string, number> = {};
  let active = 0;
  let maxActive = 0;
  const ctx: ProbeContext = {
    async fetchText() {
      return { status: 404, headers: new Headers(), body: "" };
    },
    async fileExists() {
      return false;
    },
    async run(command) {
      runs[command] = (runs[command] ?? 0) + 1;
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, delayMs));
      active--;
      return { code: fail.includes(command) ? 1 : 0, stdout: "" };
    },
  };
  return { ctx, runs, maxActive: () => maxActive };
}

const probed = (id: string, command: string) =>
  fact({ id, key: tk(id, s1), title: id, origin: s1, value: "x", verify: cmd(`${command} works`, command, []), evidence: "live" });
const keep = (id: string, restsOn: readonly PresentDef[]) =>
  decision({ id, title: id, origin: s1, restsOn, review: "60d", verify: review({ by: "owner", at: "2026-10-01", every: "60d" }), evidence: "human" });

describe("live probes run in parallel, once each (SPEC §9)", () => {
  it("starts the probes together instead of one after another", async () => {
    const c = countingCtx([], 20);
    const facts = ["a", "b", "c", "d"].map((n) => probed(`f.${n}`, n));
    await compile([...facts, keep("d.all", facts)], { today, ctx: c.ctx });
    expect(c.maxActive()).toBeGreaterThan(1);
  });

  it("never runs more than 16 probes at a time", async () => {
    const c = countingCtx([], 5);
    const facts = Array.from({ length: 40 }, (_, i) => probed(`f.${i}`, `c${i}`));
    await compile([...facts, keep("d.all", facts)], { today, ctx: c.ctx });
    expect(c.maxActive()).toBeLessThanOrEqual(16);
  });

  it("runs a probe once even when two definitions or two passes need it", async () => {
    const c = countingCtx();
    const check = cmd("site works", "site", []);
    const f1 = fact({ id: "f1", key: tk("f1", s1), title: "f1", origin: s1, value: "x", verify: check, evidence: "live" });
    const f2 = fact({ id: "f2", key: tk("f2", s1), title: "f2", origin: s1, value: "x", verify: check, evidence: "live" });
    await compile([f1, f2, keep("d", [f1, f2])], { today, ctx: c.ctx });
    expect(c.runs["site"]).toBe(1);
  });
});

describe("probe cache and scope (SPEC §9)", () => {
  const green = (at: string) => ({ status: "green" as const, at });

  it("outside the scope, a fresh green cached result is reused", async () => {
    const c = countingCtx();
    const f = probed("f", "site");
    const cache: ProbeCache = { "site works — runs: site": green(hoursAgo(1)) };
    const r = await compile([f, keep("d", [f])], { today, ctx: c.ctx, now, probeCache: cache, scope: () => false });
    expect(c.runs["site"]).toBeUndefined();
    expect(r.results.get("f")!.status).toBe("green");
  });

  it("without a scope (full check) every probe runs live, cache or not", async () => {
    const c = countingCtx();
    const f = probed("f", "site");
    await compile([f, keep("d", [f])], { today, ctx: c.ctx, now, probeCache: { "site works — runs: site": green(hoursAgo(1)) } });
    expect(c.runs["site"]).toBe(1);
  });

  it("outside the scope, a probe still runs when its cached result is missing, unknown, or older than 24 hours", async () => {
    const c = countingCtx();
    const [f1, f2, f3] = [probed("f1", "new"), probed("f2", "offline"), probed("f3", "stale")];
    const cache: ProbeCache = { "offline works — runs: offline": { status: "unknown", reason: "could not look", at: hoursAgo(1) }, "stale works — runs: stale": green(hoursAgo(25)) };
    await compile([f1, f2, f3, keep("d", [f1, f2, f3])], { today, ctx: c.ctx, now, probeCache: cache, scope: () => false });
    expect(c.runs).toEqual({ new: 1, offline: 1, stale: 1 });
  });

  it("outside the scope, a fresh cached red is reused as it is and still propagates", async () => {
    const c = countingCtx();
    const f = probed("f", "site");
    const cache: ProbeCache = { "site works — runs: site": { status: "red", reason: "site works — runs: site: exit 1", at: hoursAgo(1) } };
    const r = await compile([f, keep("d", [f])], { today, ctx: c.ctx, now, probeCache: cache, scope: () => false });
    expect(c.runs["site"]).toBeUndefined();
    expect(r.results.get("f")!.reasons).toEqual(["site works — runs: site: exit 1"]);
    expect(r.results.get("d")!.status).toBe("red");
  });

  it("inside the scope, and along everything the scope rests on, probes run live", async () => {
    const c = countingCtx();
    const base = probed("self.github", "github");
    const site = fact({ id: "site", key: tk("site", s1), title: "site", origin: s1, value: "x", verify: cmd("site works", "site", []), evidence: "live" });
    const offer = keep("offer", [site, base]);
    const other = probed("other", "other");
    const cache: ProbeCache = { "github works — runs: github": green(hoursAgo(1)), "site works — runs: site": green(hoursAgo(1)), "other works — runs: other": green(hoursAgo(1)) };
    await compile([offer, other, keep("d", [other])], { today, ctx: c.ctx, now, probeCache: cache, scope: (d) => d.id === "offer" });
    expect(c.runs).toEqual({ site: 1, github: 1 });
  });

  it("a red result inside the scope still turns dependents in other areas red", async () => {
    const c = countingCtx(["site"]);
    const site = probed("site", "site");
    const elsewhere = keep("elsewhere", [site]);
    const r = await compile([site, elsewhere], { today, ctx: c.ctx, now, probeCache: {}, scope: (d) => d.id === "site" });
    expect(r.results.get("elsewhere")!.status).toBe("red");
  });

  it("every probe that ran live is written to the cache with its time", async () => {
    const c = countingCtx(["broken"]);
    const [ok, bad] = [probed("ok", "fine"), probed("bad", "broken")];
    const cache: ProbeCache = {};
    await compile([ok, bad, keep("d", [ok, bad])], { today, ctx: c.ctx, now, probeCache: cache });
    expect(cache["fine works — runs: fine"]).toEqual({ status: "green", at: new Date(now).toISOString() });
    expect(cache["broken works — runs: broken"]).toMatchObject({ status: "red", reason: "broken works — runs: broken: exit 1" });
  });
});

describe("areas (SPEC §9)", () => {
  async function memory() {
    const dir = await mkdtemp(join(tmpdir(), "alfredish-area-"));
    const dsl = pathToFileURL(resolve("src/dsl.ts")).href;
    const def = (id: string) =>
      `import { review, rule, session } from ${JSON.stringify(dsl)};\n` +
      `const s = session({ id: "s.${id}", title: "t", at: "2026-10-01", topic: "t", questions: ["?"] });\n` +
      `export const r = rule({ id: "${id}", title: "t", origin: s, text: "t", appliesTo: "x", verify: review({ by: "owner", at: "2026-10-01", every: "90d" }), evidence: "human" });\n`;
    await mkdir(join(dir, "projects", "golive", "research"), { recursive: true });
    await mkdir(join(dir, "self"), { recursive: true });
    await writeFile(join(dir, "projects", "golive", "plan.ts"), def("rule.golive"));
    await writeFile(join(dir, "projects", "golive", "research", "scan.ts"), def("rule.golive.scan"));
    await writeFile(join(dir, "self", "profile.ts"), def("rule.self"));
    return dir;
  }

  it("an area is a folder: the definitions exported from its files, sub-folders included", async () => {
    const dir = await memory();
    const defs = await areaDefs(dir, "projects/golive");
    expect(typeof defs === "string" ? defs : [...defs].map((d) => d.id).sort()).toEqual(["rule.golive", "rule.golive.scan"]);
  });

  it("the last segment is enough when it is unique; an unknown area is an error", async () => {
    const dir = await memory();
    const defs = await areaDefs(dir, "golive");
    expect(typeof defs).not.toBe("string");
    expect(await areaDefs(dir, "nowhere")).toMatch(/no area/);
  });
});

describe("the probe cache file (SPEC §9)", () => {
  it("is read back as written; a missing or broken file is an empty cache", async () => {
    const { loadProbeCache, saveProbeCache } = await import("../src/repo.ts");
    const dir = await mkdtemp(join(tmpdir(), "alfredish-cache-"));
    expect(await loadProbeCache(dir)).toEqual({});
    const cache: ProbeCache = { "site works — runs: site": { status: "green", at: hoursAgo(1) } };
    await saveProbeCache(dir, cache);
    expect(await loadProbeCache(dir)).toEqual(cache);
    await writeFile(join(dir, ".alfredish-cache.json"), "{not json");
    expect(await loadProbeCache(dir)).toEqual({});
  });
});
