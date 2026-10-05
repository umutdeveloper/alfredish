import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveBlockers, buildRecord, changesSince, groupOf, selfUpdate, textChange, TOOL_SRC, writeSigned, type Decision } from "../src/approve.ts";
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

  it("shows the owner everything they sign, never shortened: the changed words of a long text, every field of a new definition", () => {
    const old = "At session end, before the commit: re-read the whole conversation and list every decision, promise, fact, idea or change not yet recorded as a definition; show Umut that one list, record what he confirms, then build, check and make the session's commit.";
    const now = old.replace("record what he confirms, then build, check and make the session's commit.", "record what he confirms with its reason in the session's changes, then build and check; ask Umut to run alfred-approve in his own Terminal, check again, and only then make the session's commit.");
    const marked = textChange(old, now);
    expect(marked).toContain("record what he [-confirms,-] {+confirms with its reason in the session's changes,+} then");
    // Read either way, the marked text gives back exactly the old and the new text.
    const back = (t: string, keep: "old" | "new") => t.replace(keep === "old" ? / ?\{\+.*?\+\}/g : / ?\[-.*?-\]/g, "").replace(keep === "old" ? /\[-(.*?)-\]/g : /\{\+(.*?)\+\}/g, "$1").trim();
    for (const [x, y] of [[old, now], ["a b c", "a x c"], ["one two", "zero one two three"], ["same", "same"], ["drop all of this", "new"]] as const) {
      expect(back(textChange(x, y), "old")).toBe(x);
      expect(back(textChange(x, y), "new")).toBe(y);
    }
    const longVerify = "x".repeat(300);
    const c = changesSince(state({ r: item("rule", "h1", { title: "R", text: old, verify: "a" }) }), {
      r: item("rule", "h2", { title: "R", text: now, verify: longVerify }),
      n: item("rule", "h3", { id: "n", title: "New", text: old, appliesTo: "memory" }),
    });
    const changed = c.find((x) => x.id === "r")!.shown.join("\n");
    expect(changed).toContain("{+confirms with its reason in the session's changes,+}");
    expect(changed).toContain(`verify: [-a-] {+${longVerify}+}`);
    expect(c.find((x) => x.id === "n")!.shown).toEqual(["title: New", `text: ${old}`, "appliesTo: memory"]);
    const s = changesSince(undefined, { s: item("session", "h", { id: "s", kind: "session", questions: ["Why?", "How?"], changes: { r: "because" } }) });
    expect(s[0]!.shown).toEqual(["questions:", "  - Why?", "  - How?", "changes:", "  r: because"]);
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

describe("alfred approve — refuses to start when it could show the owner something false", () => {
  const memoryWith = async (src: string) => {
    const base = await mkdtemp(join(tmpdir(), "alfredish-blockers-"));
    await mkdir(join(base, "vendor/alfredish"), { recursive: true });
    await cp(src, join(base, "vendor/alfredish/src"), { recursive: true });
    await writeFile(join(base, "vendor/alfredish/PINNED"), "abc1234\n");
    return base;
  };

  it("starts when the memory uses exactly this tool's Alfredish, every definition is readable and no past is removed", async () => {
    const base = await memoryWith(TOOL_SRC);
    const changes = changesSince(state({}), { "r.new": item("rule", "h", { title: "New" }) });
    expect(await approveBlockers({ base, invalid: [], changes })).toEqual([]);
  });

  it("refuses when the memory uses another Alfredish than the tool (an older tool once misread three past events as removed)", async () => {
    const base = await memoryWith(TOOL_SRC);
    await writeFile(join(base, "vendor/alfredish/src/newer.ts"), "export const retired = 1;\n");
    const b = await approveBlockers({ base, invalid: [], changes: [] });
    expect(b).toEqual([{ message: "this alfred-approve is not the Alfredish this memory uses (abc1234), so it could misread it", update: "abc1234" }]);
  });

  it("updates itself with its own root-owned installer, once; never from the Alfredish folder", () => {
    const blockers = [{ message: "not the same", update: "abc1234" }];
    const exists = (p: string) => p === "/usr/local/lib/alfredish/install-approve.sh";
    expect(selfUpdate(blockers, { lib: "/usr/local/lib/alfredish", env: {}, exists })).toEqual({ run: ["/usr/bin/sudo", "/bin/sh", "/usr/local/lib/alfredish/install-approve.sh", "--update", "abc1234"] });
    expect(selfUpdate(blockers, { lib: "/usr/local/lib/alfredish", env: { ALFREDISH_UPDATED_TO: "abc1234" }, exists })).toEqual({ refuse: expect.stringContaining("vendor/alfredish is not exactly that commit") });
    expect(selfUpdate(blockers, { lib: "/somewhere/vendor/alfredish", env: {}, exists })).toEqual({ refuse: expect.stringContaining("cannot update itself") });
    expect(selfUpdate([{ message: "unreadable" }], { lib: "/usr/local/lib/alfredish", env: {}, exists })).toBeUndefined();
  });

  it("refuses when a definition cannot be read, and never offers to remove the past", async () => {
    const base = await memoryWith(TOOL_SRC);
    const changes = changesSince(state({ "e.past": item("event", "h1", { title: "Past" }), "i.old": item("idea", "h2", { title: "Old" }) }), {});
    const b = await approveBlockers({ base, invalid: ["e.broken"], changes });
    expect(b.map((x) => x.message)).toEqual([
      "1 definition cannot be read: e.broken — fix them first (alfred check shows why)",
      "e.past is a past record (event) and would be marked removed — the past is never removed (K5); this is a bug or tampering",
    ]);
  });
});
