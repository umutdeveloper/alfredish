#!/usr/bin/env node
// alfred check [<area>] [--quick] | build | hook | get <id> | why <id> | diff <a>[..<b>] | keys | approve   [--memory memory/index.ts]   (SPEC §9)
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collect, compile } from "./compiler.ts";
import { linkedFromOthers, nodeContext, readSigned } from "./context.ts";
import { formatCheck, formatGet, formatWhy } from "./format.ts";
import { areaDefs, checkDrops, checkHistory, headSnapshot, judgeDrops, linkLine, linkedRules, ownerRules, checkImports, checkNewEvents, checkNewKeys, movedAway, checkPast, checkReachable, checkTypeEscapes, checkViews, diff, loadProbeCache, saveProbeCache, writeViews } from "./repo.ts";
import { embedder, KEY_SIMILARITY_THRESHOLD, keyText, rank } from "./similarity.ts";
import { APPROVALS_DIR, DEFAULT_ANCHOR, loadApprovals, vendorDir } from "./approval.ts";
import { checkAlfredishCopy, checkApproval, referenceSnapshot } from "./owner.ts";
import { approveInteractive } from "./approve.ts";
import { snapshot } from "./snapshot.ts";
import { checkLocalPaths, confirmedPaths } from "./paths.ts";
import type { Def, ISODate, KeyDef } from "./types.ts";
import { buildViews } from "./views.ts";

function today(): ISODate {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` as ISODate;
}

const USAGE = "usage: alfred check [<area>] [--quick] | build | hook | get <id> | why <id> | diff <a>[..<b>] | keys <subject> | keys --like \"<text>\" | approve [--agent <ssh-agent socket>] | link <memory> <id>  [--memory memory/index.ts]";

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const mi = args.indexOf("--memory");
  const entry = resolve(mi >= 0 ? (args.splice(mi, 2)[1] ?? "") : "memory/index.ts");
  const ai = args.indexOf("--agent");
  const agentSocket = ai >= 0 ? args.splice(ai, 2)[1] : process.env["ALFREDISH_AGENT_SOCKET"] ?? process.env["SSH_AUTH_SOCK"];
  const li = args.indexOf("--like");
  const like = li >= 0 ? args.splice(li, 2)[1] : undefined;
  const qi = args.indexOf("--quick");
  const quick = qi >= 0 && args.splice(qi, 1).length > 0;
  const [cmd, arg, arg2] = args;
  if (!cmd || !["check", "build", "hook", "get", "why", "diff", "keys", "approve", "link"].includes(cmd) || (["get", "why", "diff"].includes(cmd) && !arg) || (cmd === "keys" && !arg && like === undefined) || (cmd === "link" && !arg2)) {
    console.error(USAGE);
    return 2;
  }

  const memoryDirAbs = dirname(entry);
  const base = dirname(memoryDirAbs);
  if (cmd === "hook") {
    // One hook for the repository, which may hold several memories (§2): every memory the commit touches is checked —
    // all of them when the shared Alfredish copy or the packages change. Paths are relative to the repository (K15).
    const top = await new Promise<string>((done) => execFile("git", ["rev-parse", "--show-toplevel"], { cwd: base }, (err, out) => done(err ? base : String(out).trim())));
    const cli = relative(top, fileURLToPath(import.meta.url));
    const vendor = relative(top, vendorDir(base)) || ".";
    const hook = join(top, ".git", "hooks", "pre-commit");
    const script = `#!/bin/sh
# installed by alfredish: checks every memory of this repository that the commit touches
cd "$(git rev-parse --show-toplevel)" || exit 1
staged="$(git diff --cached --name-only)"
for idx in $(find . \\( -name node_modules -o -name vendor -o -name .git \\) -prune -o -path '*/memory/index.ts' -print); do
  m="\${idx%/memory/index.ts}"; m="\${m#./}"
  if [ "$m" != "." ] && ! printf '%s\\n' "$staged" | grep -q -e "^$m/" -e "^${vendor}/" -e "^approvals/" -e "^package" -e "^node_modules"; then continue; fi
  if [ -f "$m/tsconfig.json" ] && [ -x node_modules/.bin/tsc ]; then node_modules/.bin/tsc -p "$m/tsconfig.json" --noEmit || { echo "typecheck of $m failed: commit stopped"; exit 1; }; fi
  node "${cli}" check --memory "$m/memory/index.ts" || { echo "alfred check of $m is red: commit stopped"; exit 1; }
done
`;
    await writeFile(hook, script);
    await chmod(hook, 0o755);
    console.log(`installed: ${hook}`);
    return 0;
  }
  if (cmd === "link") {
    // §9.2: what to write to rest on another memory's definition, read from that memory's signed state.
    const r = await readSigned(arg!, arg2!, "");
    if ("why" in r) {
      console.error(`${arg}:${arg2}: ${r.why}`);
      return 1;
    }
    console.log(linkLine(arg!, arg2!, r));
    return 0;
  }
  const ctx = nodeContext(base);
  const repo = { base, memoryDir: basename(memoryDirAbs), ctx };
  const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const roots = Object.values(mod);
  const { defs, invalid } = collect(roots);
  const day = today();
  // Scope (SPEC §9): a full check forces every probe live; an area forces its own chain; everything else reuses the cache.
  let scope: ((d: Def) => boolean) | undefined;
  if (cmd === "check" && arg) {
    const area = await areaDefs(memoryDirAbs, arg);
    if (typeof area === "string") {
      console.error(area);
      return 2;
    }
    scope = (d) => area.has(d);
  } else if (quick || cmd !== "check") scope = () => false;
  const probeCache = await loadProbeCache(base);
  const linkedFrom = await linkedFromOthers(base);
  const report = await compile(roots, { today: day, ctx, fileExists: ctx.fileExists, probeCache, linkedFrom, ...(scope && { scope }) });
  await saveProbeCache(base, probeCache);
  const snap = snapshot(defs);

  switch (cmd) {
    case "build": {
      const approval = existsSync(join(base, APPROVALS_DIR));
      const changed = await writeViews(buildViews(defs, report, day, { approval, linkedRules: await linkedRules(defs, ctx) }), snap, repo);
      console.log(changed.length ? changed.map((c) => (c.startsWith("removed ") ? c.replace("removed ", "removed: ") : `written: ${c}`)).join("\n") : "no changes");
      return 0;
    }
    case "check": {
      // §14: the owner's signed approvals, if this memory has them (K27), are the reference (K28) and mark what is
      // unapproved (K26).
      const approvals = await loadApprovals(base, process.env["ALFREDISH_ANCHOR"] ?? DEFAULT_ANCHOR);
      const linked = await linkedRules(defs, ctx);
      const signed = approvals.state;
      const reference = signed && signed.records > 0 ? referenceSnapshot(signed) : undefined;
      report.issues.push(
        ...approvals.issues,
        ...(signed ? checkApproval(snap, defs, signed) : []),
        ...(signed ? await checkAlfredishCopy(base, signed, process.env["ALFREDISH_ANCHOR"] ?? DEFAULT_ANCHOR) : []),
        ...(await checkViews(buildViews(defs, report, day, { approval: signed !== undefined, linkedRules: linked }), snap, repo)),
        ...ownerRules(defs, linked),
        ...(await checkPast(snap, day, repo, reference)),
        ...(await checkDrops(snap, day, reference ?? (await headSnapshot(repo)), undefined, signed?.removed)),
        ...(await checkImports(repo)),
        ...(await checkTypeEscapes(repo)),
        ...(await checkHistory(snap, day, repo, reference)),
        ...(await checkReachable(memoryDirAbs, new Set<unknown>([...defs, ...invalid.keys()]), base)),
        ...(await checkNewKeys(defs, repo, undefined, reference)),
        ...(await checkNewEvents(defs, repo, undefined, reference)),
        ...checkLocalPaths(snap, confirmedPaths(defs)),
      );
      console.log(formatCheck(report));
      // Steers any agent, whether or not it read AGENTS.md: approval is the owner's step, never the agent's.
      const waiting = new Set(report.issues.filter((i) => i.rule === "K26" || i.rule === "K28").map((i) => i.id)).size;
      if (waiting) console.log(`→ ${waiting} item${waiting === 1 ? "" : "s"} not approved by the owner yet: tell them why, and ask them to run alfred-approve in this folder in their own terminal. Never approve for them.`);
      return report.issues.some((i) => i.status === "red") ? 1 : 0;
    }
    case "approve": {
      // §14: run by the owner, from Alfredish installed outside the memory; refuses when the records do not check out.
      const anchor = process.env["ALFREDISH_ANCHOR"] ?? DEFAULT_ANCHOR;
      const approvals = await loadApprovals(base, anchor);
      if (approvals.issues.length) {
        console.log(approvals.issues.map((i) => `✗ ${i.id} — ${i.rule}: ${i.message}`).join("\n"));
        return 1;
      }
      // A past record may be offered for removal only when it moved into another memory that signed it (K5), or when it
      // is an event dropped as a repeat that passes K32.
      const moved = new Map([...(await movedAway(snap, day, ctx))].filter(([, m]) => !m.why).map(([id, m]) => [id, m.memory] as const));
      const signedRef = approvals.state && approvals.state.records > 0 ? referenceSnapshot(approvals.state) : undefined;
      const drops = await judgeDrops(snap, day, signedRef, undefined, approvals.state?.removed);
      const dropIssues = new Map(drops.issues.map((i) => [i.id, i.message] as const));
      return approveInteractive({ base, snap, state: approvals.state, anchorPath: anchor, today: day, invalid: [...invalid.keys()].map((d) => d.id), moved, dropped: drops.valid, dropIssues, ...(agentSocket && { agentSocket }) });
    }
    case "keys": {
      const keys = defs.filter((d): d is KeyDef => d.kind === "key");
      if (like === undefined) {
        const mine = keys.filter((k) => k.subject === arg);
        console.log(mine.length ? mine.map((k) => `${k.id} — ${k.valueType} · ${k.describe}`).join("\n") : `no keys for ${arg}`);
        return 0;
      }
      // Searches every subject, as K23 does: the same property may be filed under another subject.
      const close = (await rank(await embedder(), keyText({ name: like, describe: like }), keys)).filter((r) => r.score >= KEY_SIMILARITY_THRESHOLD);
      console.log(close.length ? close.map((r) => `${r.score.toFixed(2)}  ${r.key.id} — ${r.key.describe}`).join("\n") : `no key at or above ${KEY_SIMILARITY_THRESHOLD}`);
      return 0;
    }
    case "diff": {
      const lines = await diff(defs, arg!, repo);
      if (typeof lines === "string") {
        console.log(lines);
        return 1;
      }
      console.log(lines.length ? lines.map((l) => `${l.op} ${l.kind} ${l.id} — ${l.detail}`).join("\n") : "no difference");
      return 0;
    }
    default:
      console.log(cmd === "get" ? formatGet(report, arg!) : formatWhy(report, arg!));
      return report.results.get(arg!)?.status === "red" ? 1 : 0;
  }
}

process.exitCode = await main(process.argv.slice(2));
