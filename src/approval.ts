// SPEC §14 owner approval: signed approval records (K27) and the approved state they add up to (K26, K28).
// Verifying needs only the owner's public keys (the anchor) and ssh-keygen; no agent ever signs.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Issue } from "./compiler.ts";
import type { ISODate } from "./types.ts";

export const DEFAULT_ANCHOR = "/etc/alfredish/owner.pub";
export const NAMESPACE = "alfredish";
export const APPROVALS_DIR = "approvals";

export interface ApprovedItem {
  kind: string;
  hash: string;
  data: Record<string, unknown>;
}

/** One approval round, signed by the owner. `base` is the sha256 of the previous record file (null for the first). */
export interface ApprovalRecord {
  n: number;
  at: ISODate;
  base: string | null;
  /** sha256 of the memory's vendor/alfredish tree at approval time (K28). */
  alfredish: string | null;
  approved: Record<string, ApprovedItem>;
  removed: string[];
  rejected: Record<string, { hash: string; note?: string }>;
  corrections: Record<string, { hash: string; note: string }>;
}

/** What all valid records add up to. */
export interface ApprovedState {
  records: number;
  last: ApprovalRecord | undefined;
  items: Map<string, ApprovedItem>;
  rejected: Map<string, { hash: string; note?: string }>;
  corrections: Map<string, { hash: string; note: string }>;
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const recordName = (n: number) => `${String(n).padStart(4, "0")}.json`;

/** The anchor: the owner's public keys, one per line (comments and blank lines ignored). */
export async function readAnchor(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function run(cmd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { env: env ?? process.env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => done({ code: 127, out: e.message }));
    p.on("close", (code) => done({ code: code ?? 1, out }));
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

/** True when `sig` is a valid signature of `data` by one of the anchor keys. */
export async function verifySignature(data: string, sig: string, anchorKeys: readonly string[]): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "alfredish-verify-"));
  try {
    const signers = anchorKeys.map((k) => `owner ${k.split(/\s+/).slice(0, 2).join(" ")}`).join("\n") + "\n";
    await writeFile(join(dir, "allowed_signers"), signers);
    await writeFile(join(dir, "data.sig"), sig);
    const r = await run("ssh-keygen", ["-Y", "verify", "-f", join(dir, "allowed_signers"), "-I", "owner", "-n", NAMESPACE, "-s", join(dir, "data.sig")], data);
    return r.code === 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Signs a file with ssh-keygen. `keyFile` is a private key file, or a public key whose private half is in the
 * ssh-agent at `agentSocket` (e.g. a Secure Enclave key). Writes `<file>.sig`.
 */
export async function signFile(file: string, keyFile: string, agentSocket?: string): Promise<{ ok: boolean; out: string }> {
  const env = agentSocket ? { ...process.env, SSH_AUTH_SOCK: agentSocket } : process.env;
  const r = await run("ssh-keygen", ["-Y", "sign", "-f", keyFile, "-n", NAMESPACE, file], undefined, env);
  return { ok: r.code === 0, out: r.out };
}

/** sha256 over a directory tree (paths and contents), for the vendor/alfredish copy (K28). */
export async function hashTree(dir: string): Promise<string | null> {
  const files: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  await walk(dir);
  if (!files.length) return null;
  const h = createHash("sha256");
  for (const f of files.sort()) {
    h.update(relative(dir, f).split(sep).join("/") + "\0");
    h.update(await readFile(f));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * K27: reads approvals/, checks every signature against the anchor and the chain of `base` hashes, and folds the
 * valid records into the approved state. An invalid record stops the fold there (nothing after it counts).
 */
export async function loadApprovals(base: string, anchorPath: string): Promise<{ state: ApprovedState | undefined; issues: Issue[] }> {
  const dir = join(base, APPROVALS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /^\d{4}\.json$/.test(n)).sort();
  } catch {
    return { state: undefined, issues: [] }; // approval not set up in this memory
  }
  const issues: Issue[] = [];
  const red = (id: string, message: string) => issues.push({ id, status: "red", rule: "K27", message });
  let keys: string[] = [];
  try {
    keys = await readAnchor(anchorPath);
  } catch {
    red(APPROVALS_DIR, `no anchor at ${anchorPath}: the owner's public keys are needed to check approvals`);
  }
  const state: ApprovedState = { records: 0, last: undefined, items: new Map(), rejected: new Map(), corrections: new Map() };
  let prevHash: string | null = null;
  for (const [i, name] of names.entries()) {
    const id = `${APPROVALS_DIR}/${name}`;
    const text = await readFile(join(dir, name), "utf8");
    let rec: ApprovalRecord;
    try {
      rec = JSON.parse(text) as ApprovalRecord;
    } catch {
      red(id, "not a valid approval record (JSON)");
      break;
    }
    if (rec.n !== i + 1) { red(id, `record number ${rec.n}, expected ${i + 1}: a record is missing or renamed`); break; }
    if (rec.base !== prevHash) { red(id, "broken chain: base does not match the previous record"); break; }
    let sig: string;
    try {
      sig = await readFile(join(dir, `${name}.sig`), "utf8");
    } catch {
      red(id, "unsigned: the signature file is missing");
      break;
    }
    if (!keys.length || !(await verifySignature(text, sig, keys))) { red(id, "bad signature: not signed by a key on the owner's anchor list"); break; }
    for (const [k, v] of Object.entries(rec.approved)) {
      state.items.set(k, v);
      state.rejected.delete(k); // approved later: an earlier rejection or correction note is settled
      state.corrections.delete(k);
    }
    for (const k of rec.removed) state.items.delete(k);
    for (const [k, v] of Object.entries(rec.rejected)) state.rejected.set(k, v);
    for (const [k, v] of Object.entries(rec.corrections)) state.corrections.set(k, v);
    state.records++;
    state.last = rec;
    prevHash = sha256(text);
  }
  return { state, issues };
}
