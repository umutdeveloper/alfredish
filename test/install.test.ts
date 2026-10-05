import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_SHA256 } from "../src/similarity.ts";
import { createHash } from "node:crypto";

// K32 judges a drop with the embedding model inside alfred-approve, so the installed copy must carry the model, and an
// update must bring the model (and the installer) of the commit it installs.
const repo = fileURLToPath(new URL("..", import.meta.url));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("install-approve.sh carries the embedding model (K32)", () => {
  it("the first install and an update both leave the pinned model next to the code", async () => {
    const root = await mkdtemp(join(tmpdir(), "alfredish-install-"));
    const pub = join(root, "owner.pub");
    await writeFile(pub, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample alfred-owner\n");
    const env = { ...process.env, PREFIX: root, ANCHOR_DIR: join(root, "etc"), OWNER_PUB: pub, NO_CHOWN: "1" };
    execFileSync("/bin/sh", [join(repo, "scripts/install-approve.sh")], { env, stdio: "pipe" });
    const lib = join(root, "lib/alfredish");
    const model = join(lib, "models/nomic-embed-text-v1.5.Q4_K_M.gguf");
    expect(sha(model)).toBe(MODEL_SHA256);

    const head = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("/bin/sh", [join(lib, "install-approve.sh"), "--update", head], { env, stdio: "pipe" });
    expect(sha(model)).toBe(MODEL_SHA256);
    expect(readFileSync(join(lib, "PINNED"), "utf8").trim()).toBe(head);
    // The update installs that commit's installer too, so the next update follows the code it came with.
    expect(readFileSync(join(lib, "install-approve.sh"), "utf8")).toBe(execFileSync("git", ["-C", repo, "show", `${head}:scripts/install-approve.sh`], { encoding: "utf8" }));
    expect(existsSync(join(lib, "src/cli.ts"))).toBe(true);
  }, 120_000);
});
