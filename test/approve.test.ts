import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecord, changesSince, groupOf, writeSigned, type Decision } from "../src/approve.ts";
import { loadApprovals, recordName, type ApprovedState } from "../src/approval.ts";
import type { Snapshot } from "../src/snapshot.ts";

let keys: string;
beforeAll(async () => {
  keys = await mkdtemp(join(tmpdir(), "alfredish-approve-keys-"));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "owner", "-f", join(keys, "owner")]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "other", "-f", join(keys, "other")]);
  await writeFile(join(keys, "anchor.pub"), await readFile(join(keys, "owner.pub"), "utf8"));
});

const item = (kind: string, hash: string, data: Record<string, unknown>) => ({ kind, hash, data });
const state = (items: Record<string, ReturnType<typeof item>>, extra: Partial<ApprovedState> = {}): ApprovedState => ({
  records: 1, last: undefined, items: new Map(Object.entries(items)), rejected: new Map(), corrections: new Map(), ...extra,
});

describe("alfred approve — what changed (§14)", () => {
  it("groups by kind and verification: owner's calls first, built-in probes as machine-checked", () => {
    expect(groupOf("~", "decision", { verify: "review by owner" })).toBe("owner");
    expect(groupOf("~", "fact", { verify: 'page https://e.com contains "$290"' })).toBe("machine");
    expect(groupOf("~", "fact", { verify: "backups — runs: true" })).toBe("owner"); // cmd: the owner judges the command
    expect(groupOf("~", "fact", { verify: "finding r#k (ttl 90d)" })).toBe("owner"); // research: expiry is not truth
    expect(groupOf("~", "asset", { verify: "file /x exists", location: { kind: "local", path: "/x" } })).toBe("owner");
    expect(groupOf("-", "fact", undefined)).toBe("owner");
  });

  it("lists new, changed and removed definitions with their reasons and the owner's last note", () => {
    const before = state({ "f.price": item("fact", "h1", { title: "Price", value: "$290", verify: 'page https://e.com contains "$290"' }), "d.old": item("decision", "h2", { title: "Old" }) },
      { corrections: new Map([["f.price", { hash: "h1", note: "check the page" }]]) });
    const now: Snapshot = {
      "f.price": item("fact", "h3", { title: "Price", value: "$390", verify: 'page https://e.com contains "$390"' }),
      "r.new": item("rule", "h4", { title: "New rule" }),
      "s.today": item("session", "h5", { at: "2026-10-04", changes: { "f.price": "price went up", "r.new": "Umut asked" } }),
    };
    const c = changesSince(before, now);
    expect(c.map((x) => `${x.group} ${x.op} ${x.id}`)).toEqual(["owner - d.old", "owner + r.new", "owner + s.today", "machine ~ f.price"]);
    const price = c.find((x) => x.id === "f.price")!;
    expect(price).toMatchObject({ why: "price went up", note: "check the page", test: 'page https://e.com contains "$390"' });
    expect(price.detail).toContain('value: "$290" → "$390"');
  });
});

describe("alfred approve — the record and its signature (§14, K27)", () => {
  const now: Snapshot = { "a": item("rule", "ha", { title: "A" }), "b": item("rule", "hb", { title: "B" }), "c": item("rule", "hc", { title: "C" }), "d": item("rule", "hd", { title: "D" }) };
  const changes = changesSince(state({ gone: item("rule", "hg", {}) }), now);
  const decisions = new Map<string, Decision>([["a", { kind: "approve" }], ["b", { kind: "correct", note: "shorter" }], ["c", { kind: "reject", note: "no" }], ["d", { kind: "skip" }], ["gone", { kind: "approve" }]]);

  it("approve, correct, reject, skip and an approved removal make the record", () => {
    const rec = buildRecord(state({ gone: item("rule", "hg", {}) }), now, changes, decisions, "2026-10-04", { now: "v2", approve: false }, "previous record text");
    expect(rec.n).toBe(2);
    expect(Object.keys(rec.approved)).toEqual(["a"]);
    expect(rec.corrections).toEqual({ b: { hash: "hb", note: "shorter" } });
    expect(rec.rejected).toEqual({ c: { hash: "hc", note: "no" } });
    expect(rec.removed).toEqual(["gone"]);
    expect(rec.alfredish).toBeNull(); // the Alfredish copy was not approved: the previous value (none) stays
  });

  it("a signed round checks out and becomes the approved state", async () => {
    const base = await mkdtemp(join(tmpdir(), "alfredish-approve-"));
    const rec = buildRecord(undefined, now, changesSince(undefined, now), new Map([["a", { kind: "approve" }]]), "2026-10-04", { now: null, approve: false });
    expect(await writeSigned(base, rec, join(keys, "anchor.pub"), undefined, join(keys, "owner"))).toEqual({ ok: true, message: "approval 1 signed" });
    const { state: s, issues } = await loadApprovals(base, join(keys, "anchor.pub"));
    expect(issues).toEqual([]);
    expect(s?.items.get("a")?.hash).toBe("ha");
  });

  it("with no owner key able to sign, nothing is recorded", async () => {
    const base = await mkdtemp(join(tmpdir(), "alfredish-approve-"));
    const rec = buildRecord(undefined, now, changesSince(undefined, now), new Map([["a", { kind: "approve" }]]), "2026-10-04", { now: null, approve: false });
    const r = await writeSigned(base, rec, join(keys, "anchor.pub"), join(keys, "no-such-agent.sock"));
    expect(r).toEqual({ ok: false, message: "no owner key on this machine could sign — nothing recorded" });
    expect(existsSync(join(base, "approvals", recordName(1)))).toBe(false);
  });
});
