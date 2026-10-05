import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApprovals, recordName, sha256, signFile, type ApprovalRecord } from "../src/approval.ts";

let keyDir: string;
let owner: string; // private key file of the test owner
let stranger: string;
beforeAll(async () => {
  keyDir = await mkdtemp(join(tmpdir(), "alfredish-keys-"));
  for (const name of ["owner", "stranger"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", join(keyDir, name)]);
  owner = join(keyDir, "owner");
  stranger = join(keyDir, "stranger");
  await writeFile(join(keyDir, "anchor.pub"), `# the owner's keys\n${await readFile(`${owner}.pub`, "utf8")}`);
});

const rec = (n: number, base: string | null, approved: Record<string, string>): ApprovalRecord => ({
  n, at: "2026-10-04", base, alfredish: null,
  approved: Object.fromEntries(Object.entries(approved).map(([id, hash]) => [id, { kind: "fact", hash, data: { id } }])),
  removed: [], rejected: {}, corrections: {},
});

async function memory(records: { r: ApprovalRecord; key: string; tamper?: (t: string) => string }[]) {
  const base = await mkdtemp(join(tmpdir(), "alfredish-approvals-"));
  await mkdir(join(base, "approvals"));
  let prev: string | null = null;
  for (const { r, key, tamper } of records) {
    const text = JSON.stringify({ ...r, base: r.base === null && prev ? prev : r.base }, null, 1);
    const file = join(base, "approvals", recordName(r.n));
    await writeFile(file, text);
    const s = await signFile(file, key);
    if (!s.ok) throw new Error(s.out);
    if (tamper) await writeFile(file, tamper(text));
    prev = sha256(text);
  }
  return base;
}

describe("K27 — approval records are checked", () => {
  it("valid signed records add up to the approved state", async () => {
    const base = await memory([{ r: rec(1, null, { "f.a": "h1", "f.b": "h2" }), key: owner }, { r: rec(2, null, { "f.a": "h3" }), key: owner }]);
    const { state, issues } = await loadApprovals(base, join(keyDir, "anchor.pub"));
    expect(issues).toEqual([]);
    expect(state?.records).toBe(2);
    expect(state?.items.get("f.a")?.hash).toBe("h3");
    expect(state?.items.get("f.b")?.hash).toBe("h2");
  });

  it("every id a signed record removed is remembered (K32: a signed drop has nothing left to judge)", async () => {
    const base = await memory([{ r: rec(1, null, { "f.a": "h1", "f.b": "h2" }), key: owner }, { r: { ...rec(2, null, {}), removed: ["f.b"] }, key: owner }]);
    const { state } = await loadApprovals(base, join(keyDir, "anchor.pub"));
    expect(state?.items.has("f.b")).toBe(false);
    expect([...(state?.removed ?? [])]).toEqual(["f.b"]);
  });

  it("a record changed after signing is red, and nothing after it counts", async () => {
    const base = await memory([{ r: rec(1, null, { "f.a": "h1" }), key: owner, tamper: (t) => t.replace('"h1"', '"h9"') }]);
    const { state, issues } = await loadApprovals(base, join(keyDir, "anchor.pub"));
    expect(issues).toEqual([expect.objectContaining({ id: "approvals/0001.json", rule: "K27", message: expect.stringContaining("bad signature") })]);
    expect(state?.records).toBe(0);
  });

  it("a record signed by a key not on the anchor list is red", async () => {
    const base = await memory([{ r: rec(1, null, { "f.a": "h1" }), key: stranger }]);
    expect((await loadApprovals(base, join(keyDir, "anchor.pub"))).issues[0]?.message).toContain("not signed by a key on the owner's anchor list");
  });

  it("a broken chain is red", async () => {
    const base = await memory([{ r: rec(1, null, { "f.a": "h1" }), key: owner }, { r: rec(2, "0".repeat(64), { "f.a": "h2" }), key: owner }]);
    const { state, issues } = await loadApprovals(base, join(keyDir, "anchor.pub"));
    expect(issues[0]?.message).toContain("broken chain");
    expect(state?.items.get("f.a")?.hash).toBe("h1"); // the valid first record still counts
  });

  it("without an anchor nothing can be checked, so it is red; without approvals/ approval is not set up", async () => {
    const base = await memory([{ r: rec(1, null, { "f.a": "h1" }), key: owner }]);
    expect((await loadApprovals(base, join(keyDir, "missing.pub"))).issues[0]?.message).toContain("no anchor");
    expect(await loadApprovals(await mkdtemp(join(tmpdir(), "alfredish-none-")), join(keyDir, "anchor.pub"))).toEqual({ state: undefined, issues: [] });
  });
});
