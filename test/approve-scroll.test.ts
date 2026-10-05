import { describe, it, expect } from "vitest";
import { entriesFor, newScreen, render, step, type Key, type Screen } from "../src/approve-screen.ts";
import { changesSince } from "../src/approve.ts";
import type { ApprovedState } from "../src/approval.ts";
import type { Snapshot } from "../src/snapshot.ts";

const item = (kind: string, hash: string, data: Record<string, unknown>) => ({ kind, hash, data });
const plain = (t: string) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const press = (s: Screen, ...ks: Key[]) => { for (const k of ks) step(s, k); return s; };

describe("§14 definitions that only gained a key come as one step", () => {
  const signed: ApprovedState = {
    records: 1, last: undefined, rejected: new Map(), corrections: new Map(),
    items: new Map(Object.entries({
      "d.host": item("decision", "h1", { title: "Host on Cloudflare Pages" }),
      "d.price": item("decision", "h2", { title: "Go-Live Check: $290" }),
      "d.font": item("decision", "h3", { title: "One font" }),
    })),
  };
  const now: Snapshot = {
    "d.host": item("decision", "h4", { title: "Host on Cloudflare Pages", key: "@key:site.hosting" }),
    "d.price": item("decision", "h5", { title: "Go-Live Check: $290", key: "@key:goLiveCheck.price" }),
    "d.font": item("decision", "h6", { title: "Two fonts", key: "@key:site.fonts" }), // more than a key changed
  };
  const changes = changesSince(signed, now);

  it("marks a change whose only difference is a new key, and only that", () => {
    expect(changes.find((c) => c.id === "d.host")?.keyOnly).toEqual({ key: "key:site.hosting", title: "Host on Cloudflare Pages" });
    expect(changes.find((c) => c.id === "d.font")?.keyOnly).toBeUndefined();
  });

  it("offers them together, each with its title and the question it answers; the others stay one by one", () => {
    const entries = entriesFor(changes, { firstRound: false });
    const g = entries.find((e) => e.key === "__keyed")!;
    expect(g.title).toBe("2 definitions got their key");
    expect(g.buttons).toEqual(["approveGroup", "startOne"]);
    expect(g.members).toEqual(["d.host", "d.price"]);
    expect(g.lines).toEqual(["~ d.host — Host on Cloudflare Pages → key:site.hosting", "~ d.price — Go-Live Check: $290 → key:goLiveCheck.price"]);
    expect(entries.some((e) => e.key === "d.font")).toBe(true);
  });
});

describe("§14 a long screen scrolls", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const screen = () => newScreen([
    { key: "a", title: "A long change", sub: "", why: "because", lines: long, buttons: ["approve", "skip"] },
    { key: "b", title: "Next change", sub: "", why: "", lines: ["short"], buttons: ["approve", "skip"] },
  ]);

  it("shows only what fits the terminal, says which lines are shown, and keeps the buttons", () => {
    const out = plain(render(screen(), { rows: 16, cols: 80 })).split("\n");
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out).toContain("line 1");
    expect(out).not.toContain("line 40");
    expect(out.some((l) => /^lines 1-\d+ of 40 · shift\+↑↓ or PgUp\/PgDn to scroll$/.test(l))).toBe(true);
    expect(out.some((l) => l.includes("approve"))).toBe(true);
  });

  it("shift+↓ and PgDn scroll; ↓ still moves to the next change and starts at its top", () => {
    const s = press(screen(), { name: "down", shift: true });
    expect(plain(render(s, { rows: 16, cols: 80 })).split("\n")).not.toContain("line 1");
    press(s, { name: "pagedown" }, { name: "pagedown" }, { name: "pagedown" }, { name: "pagedown" });
    expect(plain(render(s, { rows: 16, cols: 80 })).split("\n")).toContain("line 40");
    press(s, { name: "pageup" }, { name: "pageup" }, { name: "pageup" }, { name: "pageup" }, { name: "up", shift: true });
    expect(plain(render(s, { rows: 16, cols: 80 })).split("\n")).toContain("line 1");
    press(s, { name: "down" });
    expect(s.cur).toBe(1);
    expect(s.scroll).toBe(0);
  });

  it("without a terminal size everything is shown, as before", () => {
    expect(plain(render(screen())).split("\n")).toContain("line 40");
  });
});
