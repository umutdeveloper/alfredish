import { describe, it, expect, beforeAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { vendorDir } from "../src/approval.ts";

// A repository of memories (§2): memories/esik and memories/ada share one Alfredish copy at the repository root.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const TIMEOUT = 120_000;
const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

async function sh(cwd: string, cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await exec(cmd, args, { cwd, maxBuffer: 16 << 20 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: (x.stdout ?? "") + (x.stderr ?? "") };
  }
}
const memory = (name: string): Record<string, string> => ({
  [`${name}/memory/lang.ts`]: `export * from "../../vendor/alfredish/src/index.ts";\n`,
  [`${name}/memory/sessions.ts`]: `import { session } from "./lang.ts";\nexport const s1 = session({ id: "s.${name}", title: "Start", at: "${day}", topic: "Start", questions: ["What is ${name}?"] });\n`,
  [`${name}/memory/rules.ts`]: `import { review, rule } from "./lang.ts";\nimport { s1 } from "./sessions.ts";\nexport const r1 = rule({ id: "rule.${name}.scope", title: "Scope", origin: s1, appliesTo: "${name}", text: "Only ${name} lives here.", verify: review({ by: "owner", at: "${day}", every: "365d" }), evidence: "human" });\nexport const r2 = rule({ id: "rule.${name}.plain", title: "Plain words", origin: s1, appliesTo: "conversation", text: "Talk plainly.", verify: review({ by: "owner", at: "${day}", every: "365d" }), evidence: "human" });\n`,
  [`${name}/memory/index.ts`]: `export * from "./sessions.ts";\nexport * from "./rules.ts";\n`,
  [`${name}/tsconfig.json`]: JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, types: ["node"] }, include: ["memory"] }),
});
let root: string;
const git = (...a: string[]) => sh(root, "git", a);
const check = (name: string) => sh(root, process.execPath, ["vendor/alfredish/src/cli.ts", "check", "--memory", `${name}/memory/index.ts`]);

beforeAll(async () => {
  root = join(await mkdtemp(join(tmpdir(), "alfredish-memories-")), "memories");
  for (const [path, text] of Object.entries({ ...memory("esik"), ...memory("ada"), "package.json": JSON.stringify({ name: "memories", private: true, type: "module" }), ".gitignore": "node_modules\n.alfredish-cache.json\n" })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await cp(join(REPO, "src"), join(root, "vendor/alfredish/src"), { recursive: true });
  await symlink(join(REPO, "models"), join(root, "vendor/alfredish/models"));
  await symlink(join(REPO, "node_modules"), join(root, "node_modules"));
  await git("init", "-q");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "t");
  for (const m of ["esik", "ada"]) await sh(root, process.execPath, ["vendor/alfredish/src/cli.ts", "build", "--memory", `${m}/memory/index.ts`]);
  await sh(root, process.execPath, ["vendor/alfredish/src/cli.ts", "hook", "--memory", "esik/memory/index.ts"]);
}, TIMEOUT);

describe("a repository of memories sharing one Alfredish copy", () => {
  it("each memory finds the shared copy above it; a memory with its own copy keeps it", async () => {
    expect(vendorDir(join(root, "esik"))).toBe(join(root, "vendor/alfredish"));
    expect(vendorDir(root)).toBe(join(root, "vendor/alfredish"));
  });

  it("every memory checks green on its own, importing only the shared copy", async () => {
    for (const m of ["esik", "ada"]) {
      const r = await check(m);
      expect(r.out, r.out).toMatch(/^\s*✓/);
    }
  }, TIMEOUT);

  it("the hook checks the memories a commit touches: both on the first commit, only esik when only esik changes", async () => {
    await git("add", "-A");
    const first = await git("commit", "-qm", "two memories");
    expect(first.code, first.out).toBe(0);
    expect(first.out.match(/✓/g)?.length).toBe(2);
    await writeFile(join(root, "esik/memory/rules.ts"), (await readFile(join(root, "esik/memory/rules.ts"), "utf8")).replace("Only esik lives here.", "Only esik lives here, nothing else."));
    await sh(root, process.execPath, ["vendor/alfredish/src/cli.ts", "build", "--memory", "esik/memory/index.ts"]);
    await git("add", "-A");
    const second = await git("commit", "-qm", "esik only");
    expect(second.code, second.out).toBe(0);
    expect(second.out.match(/✓/g)?.length).toBe(1);
  }, TIMEOUT);

  it("a memory may not load another memory's files (K15): it rests on them with a link", async () => {
    await writeFile(join(root, "esik/memory/borrowed.ts"), `export { r1 as adaScope } from "../../ada/memory/rules.ts";\n`);
    await writeFile(join(root, "esik/memory/index.ts"), `export * from "./sessions.ts";\nexport * from "./rules.ts";\nexport * from "./borrowed.ts";\n`);
    const r = await check("esik");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ada\/memory\/rules\.ts — K15: the memory's program loads this file from outside the memory folder/);
    await git("add", "-A");
    const c = await git("commit", "-qm", "borrow");
    expect(c.code).not.toBe(0);
    expect(c.out).toContain("alfred check of esik is red: commit stopped");
    await git("reset", "-q", "--hard");
    await git("clean", "-qfd", "-e", "node_modules", "-e", "vendor");
  }, TIMEOUT);

  it("a memory without the owner's conversation rules is red (K31): its agent would work without them", async () => {
    const rules = join(root, "ada/memory/rules.ts");
    const before = await readFile(rules, "utf8");
    await writeFile(rules, before.replace(/export const r2 = .*\n/, ""));
    const r = await check("ada");
    expect(r.code).toBe(1);
    expect(r.out).toContain("AGENTS.md — K31: no rule tells an agent here how to talk to the owner");
    await writeFile(rules, before);
  }, TIMEOUT);
});

describe("a shared copy is approved once, for every memory of the repository (§9.3, K28)", () => {
  let keys: string;
  const signRecord = async (dir: string, n: number, alfredish: string | null, approved: Record<string, unknown>, prev?: string) => {
    const { sha256, signFile, recordName } = await import("../src/approval.ts");
    const rec = { n, at: day, base: prev === undefined ? null : sha256(prev), alfredish, approved, removed: [], rejected: {}, corrections: {} };
    const text = JSON.stringify(rec, null, 1);
    await mkdir(join(dir, "approvals"), { recursive: true });
    await writeFile(join(dir, "approvals", recordName(n)), text);
    const r = await signFile(join(dir, "approvals", recordName(n)), join(keys, "owner"));
    if (!r.ok) throw new Error(r.out);
    return text;
  };
  const vendorHash = async () => (await import("../src/approval.ts")).hashTree(join(root, "vendor/alfredish"));

  beforeAll(async () => {
    keys = await mkdtemp(join(tmpdir(), "alfredish-shared-keys-"));
    await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "owner", "-f", join(keys, "owner")]);
    await writeFile(join(keys, "anchor.pub"), await readFile(join(keys, "owner.pub"), "utf8"));
    process.env["ALFREDISH_ANCHOR"] = join(keys, "anchor.pub");
    // Each memory signs its own content; the repository signs the shared copy once.
    for (const m of ["esik", "ada"]) {
      const snap = JSON.parse(await readFile(join(root, m, "memory/snapshot.json"), "utf8"));
      await signRecord(join(root, m), 1, null, snap);
    }
    await signRecord(root, 1, await vendorHash(), {});
    for (const m of ["esik", "ada"]) await sh(root, process.execPath, ["vendor/alfredish/src/cli.ts", "build", "--memory", `${m}/memory/index.ts`]);
  }, TIMEOUT);

  it("both memories accept the copy the repository signed; a change to it is red in both until one new repository record", async () => {
    for (const m of ["esik", "ada"]) expect((await check(m)).out).toMatch(/^\s*✓/);
    const f = join(root, "vendor/alfredish/src/format.ts");
    const before = await readFile(f, "utf8");
    await writeFile(f, before + "\n// a change to the shared copy\n");
    for (const m of ["esik", "ada"]) expect((await check(m)).out).toContain("vendor/alfredish — K28: the copy of Alfredish changed since the owner's last approval for this repository of memories");
    await signRecord(root, 2, await vendorHash(), {}, await readFile(join(root, "approvals/0001.json"), "utf8"));
    for (const m of ["esik", "ada"]) expect((await check(m)).out).toMatch(/^\s*✓/);
    await writeFile(f, before);
    await signRecord(root, 3, await vendorHash(), {}, await readFile(join(root, "approvals/0002.json"), "utf8"));
  }, TIMEOUT);

  it("alfred approve in any one memory writes the shared copy's approval into the repository's records, not the memory's", async () => {
    const f = join(root, "vendor/alfredish/src/format.ts");
    const before = await readFile(f, "utf8");
    await writeFile(f, before + "\n// another change\n");
    const sock = join(keys, `agent-${Date.now()}.sock`);
    await exec("ssh-agent", ["-a", sock]);
    const env = { ...process.env, SSH_AUTH_SOCK: sock };
    await exec("ssh-add", [join(keys, "owner")], { env });
    const r = await new Promise<{ out: string }>((done) => {
      const p = spawn(process.execPath, [join(root, "vendor/alfredish/src/cli.ts"), "approve", "--agent", sock], { cwd: join(root, "ada"), env });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", () => done({ out }));
      p.stdin.end("y\n");
    });
    expect(r.out, r.out).toContain("shared by every memory of this repository of memories");
    expect(r.out).toContain("repository approval 4 signed");
    expect(r.out).not.toMatch(/^approval \d+ signed/m); // nothing of ada's own content changed: no record of its own
    for (const m of ["esik", "ada"]) expect((await check(m)).out, m).toMatch(/^\s*✓/);
    await writeFile(f, before);
  }, TIMEOUT);
});

