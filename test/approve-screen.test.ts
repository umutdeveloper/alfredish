import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entriesFor, newScreen, render, step, VENDOR_KEY, type Key, type Screen } from "../src/approve-screen.ts";
import { alfredishCopyInfo, changesSince } from "../src/approve.ts";
import type { ApprovedState } from "../src/approval.ts";
import type { Snapshot } from "../src/snapshot.ts";

const item = (kind: string, hash: string, data: Record<string, unknown>) => ({ kind, hash, data });
const before: ApprovedState = {
  records: 1, last: undefined, rejected: new Map(), corrections: new Map(),
  items: new Map(Object.entries({ "rule.budget": item("rule", "h1", { title: "Budget", text: "Spend at most 1,000 EUR a month." }), "idea.old": item("idea", "h2", { title: "Old idea", text: "An old idea." }) })),
};
const now: Snapshot = { "rule.budget": item("rule", "h3", { title: "Budget", text: "Spend at most 1,200 EUR a month." }) };
const changes = changesSince(before, now); // idea.old removed, rule.budget changed

const keys = (s: Screen, ...ks: (string | Key)[]) => {
  for (const k of ks) step(s, typeof k === "string" ? (k.length === 1 ? { name: k, sequence: k } : { name: k }) : k);
  return s;
};
const type = (s: Screen, text: string) => keys(s, ...[...text].map((ch) => ({ sequence: ch }) as Key));
const plain = (t: string) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

describe("alfred approve — the arrow-key screen (§14)", () => {
  it("shows every line the record is built from, the reason first", () => {
    const s = newScreen(entriesFor(changes, { firstRound: false }));
    keys(s, "down"); // idea.old is first (sorted), rule.budget second
    const text = plain(render(s));
    expect(text).toContain("rule.budget · rule · changed");
    for (const line of changes.find((c) => c.id === "rule.budget")!.shown) expect(text).toContain(plain(line));
    expect(text.indexOf("why:")).toBeLessThan(text.indexOf("text:"));
  });

  it("arrows choose, enter applies, a note is typed in place, and the summary comes before the one signature", () => {
    const s = newScreen(entriesFor(changes, { firstRound: false, vendor: ["Alfredish abc1234", "✓ the copy is exactly the files of Alfredish abc1234"] }));
    keys(s, "return"); // vendor: approve
    keys(s, "right", "return"); // idea.old removal: skip
    keys(s, "right", "right", "return"); // rule.budget: reject…
    type(s, "too much");
    keys(s, "backspace", "backspace", "backspace", "backspace");
    type(s, "high");
    keys(s, "return"); // …with a note
    expect(s.mode).toBe("summary");
    expect(s.decisions.get(VENDOR_KEY)).toEqual({ kind: "approve" });
    expect(s.decisions.get("idea.old")).toEqual({ kind: "skip" });
    expect(s.decisions.get("rule.budget")).toEqual({ kind: "reject", note: "too high" });
    const summary = plain(render(s));
    expect(summary).toContain("✗ rule.budget — rejected: too high");
    expect(summary).toContain("· idea.old — skipped");
    keys(s, "return");
    expect(s.mode).toBe("signed");
  });

  it("a removal offers only approve removal or skip", () => {
    const s = newScreen(entriesFor(changes, { firstRound: false }));
    expect(plain(render(s))).toMatch(/approve removal\s+\[ skip \]/);
    keys(s, "right", "right", "return"); // wraps around to approve removal
    expect(s.decisions.get("idea.old")).toEqual({ kind: "approve" });
  });

  it("a correction needs a note; escape goes back without deciding", () => {
    const s = newScreen(entriesFor(changes, { firstRound: false }));
    keys(s, "down", "right", "return", "return");
    expect(s.mode).toBe("note");
    expect(plain(render(s))).toContain("write the note first");
    keys(s, "escape");
    expect(s.mode).toBe("browse");
    expect(s.decisions.has("rule.budget")).toBe(false);
    keys(s, "return"); // the choice stays on correct
    type(s, "say 1,100");
    keys(s, "return");
    expect(s.decisions.get("rule.budget")).toEqual({ kind: "correct", note: "say 1,100" });
  });

  it("with nothing decided the summary cannot sign: enter goes back", () => {
    const s = newScreen(entriesFor(changes, { firstRound: false }));
    keys(s, "right", "return", "right", "right", "right", "return"); // skip both
    expect(s.mode).toBe("summary");
    expect(plain(render(s))).toContain("Nothing decided");
    keys(s, "return");
    expect(s.mode).toBe("browse");
  });

  it("the first round can approve the whole memory as the starting point", () => {
    const s = newScreen(entriesFor(changes, { firstRound: true, vendor: ["Alfredish abc1234"] }));
    expect(plain(render(s))).toContain("First approval: 2 definitions make up the memory today.");
    keys(s, "return");
    expect(s.mode).toBe("summary");
    expect([...s.decisions.keys()].sort()).toEqual(["idea.old", "rule.budget", VENDOR_KEY].sort());
  });

  it("q and ctrl-c quit without signing; q inside a note is a letter", () => {
    const s = newScreen(entriesFor(changes, { firstRound: false }));
    keys(s, "down", "right", "return", "q");
    expect(s.note).toBe("q");
    keys(s, { name: "c", ctrl: true });
    expect(s.mode).toBe("quit");
    expect(keys(newScreen(entriesFor(changes, { firstRound: false })), "q").mode).toBe("quit");
  });
});

describe("alfred approve — machine-checked changes together", () => {
  it("offers one step that approves every machine-checked change, after the owner's calls", () => {
    const m = (id: string): (typeof changes)[number] => ({ id, op: "~", kind: "asset", group: "machine", detail: "", shown: [`verify: ${id}`], test: `github ${id} exists`, why: "built-in test now" });
    const list = [changes.find((c) => c.id === "rule.budget")!, m("project.a"), m("project.b")];
    const s = newScreen(entriesFor(list, { firstRound: false }));
    keys(s, "return"); // rule.budget: approve
    const text = plain(render(s));
    expect(text).toContain("2 machine-checked changes");
    expect(text).toContain("~ project.a — built-in test now");
    expect(text).toContain("    test: github project.b exists");
    keys(s, "return"); // approve all of them
    expect(s.mode).toBe("summary");
    expect([...s.decisions].map(([k, d]) => `${k}:${d.kind}`)).toEqual(["rule.budget:approve", "project.a:approve", "project.b:approve"]);
    expect(plain(render(s))).not.toContain("machine-checked"); // a group is not a decision of its own
  });

  it("can still look at them one by one", () => {
    const m = (id: string): (typeof changes)[number] => ({ id, op: "~", kind: "asset", group: "machine", detail: "", shown: [], test: "t" });
    const s = newScreen(entriesFor([m("project.a"), m("project.b")], { firstRound: false }));
    keys(s, "right", "return", "right", "right", "right", "return"); // look one by one, then skip project.a
    expect(s.decisions.get("project.a")).toEqual({ kind: "skip" });
    expect(s.entries[s.cur]!.key).toBe("project.b");
  });
});

describe("alfred approve — definitions that moved into another memory", () => {
  it("their removals come as one step per destination, and one press removes them all", () => {
    const gone = (id: string, kind: string): (typeof changes)[number] => ({ id, op: "-", kind, group: "owner", detail: "", shown: [] });
    const list = [gone("esik.a", "fact"), gone("event.esik.b", "event"), gone("idea.other", "idea")];
    const s = newScreen(entriesFor(list, { firstRound: false, moved: new Map([["esik.a", "esik"], ["event.esik.b", "esik"]]) }));
    const text = plain(render(s));
    expect(text).toContain("2 definitions moved to esik");
    expect(text).toContain("- event.esik.b  (event)");
    keys(s, "return");
    expect(s.decisions.get("esik.a")).toEqual({ kind: "approve" });
    expect(s.decisions.get("event.esik.b")).toEqual({ kind: "approve" });
    expect(s.entries[s.cur]!.key).toBe("idea.other"); // a removal that did not move is still decided on its own
  });
});

describe("alfred approve — the memory's copy of Alfredish (§14, K28)", () => {
  it("says whether the copy is exactly the commit it names, and lists the commits since the last approved one", async () => {
    const root = await mkdtemp(join(tmpdir(), "alfredish-copy-test-"));
    const src = join(root, "alfredish");
    await mkdir(join(src, "src"), { recursive: true });
    await mkdir(join(src, "models"));
    const g = (...a: string[]) => execFileSync("git", ["-C", src, ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    await writeFile(join(src, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(src, "SPEC.md"), "spec\n");
    await writeFile(join(src, "package.json"), "{}\n");
    await writeFile(join(src, "models/m.bin"), "model\n");
    g("add", "-A");
    g("commit", "-qm", "first");
    const first = g("rev-parse", "--short", "HEAD");
    await writeFile(join(src, "src/a.ts"), "export const a = 2;\n");
    g("commit", "-qam", "second: a is 2");
    const second = g("rev-parse", "--short", "HEAD");

    const memory = join(root, "memory");
    const vendor = join(memory, "vendor/alfredish");
    await mkdir(vendor, { recursive: true });
    for (const p of ["src", "SPEC.md", "package.json", "models"]) await cp(join(src, p), join(vendor, p), { recursive: true });
    await writeFile(join(vendor, "PINNED"), `${second}\n`);

    const ok = await alfredishCopyInfo(memory, first, src);
    expect(ok.pinned).toBe(second);
    expect(ok.lines).toContain(`✓ the copy is exactly the files of Alfredish ${second}`);
    expect(ok.lines.join("\n")).toContain("second: a is 2");
    expect(ok.lines.join("\n")).not.toContain(" first");

    await writeFile(join(vendor, "src/extra.ts"), "export {};\n"); // a file the commit does not have
    expect((await alfredishCopyInfo(memory, first, src)).lines).toContain(`✗ the copy is NOT the files of Alfredish ${second}: do not approve it`);

    expect((await alfredishCopyInfo(memory, first)).lines).toContain("? the copy cannot be compared with Alfredish's source on this machine");
  });
});
