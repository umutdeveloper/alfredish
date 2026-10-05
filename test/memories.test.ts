import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
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

