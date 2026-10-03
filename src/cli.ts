#!/usr/bin/env node
// alfred check [<area>] [--quick] | build | hook | get <id> | why <id> | diff <a>[..<b>]   [--memory memory/index.ts]   (SPEC §9)
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collect, compile } from "./compiler.ts";
import { nodeContext } from "./context.ts";
import { formatCheck, formatGet, formatWhy } from "./format.ts";
import { areaDefs, checkImports, checkPast, checkViews, diff, loadProbeCache, saveProbeCache, writeViews } from "./repo.ts";
import { snapshot } from "./snapshot.ts";
import type { Def, ISODate } from "./types.ts";
import { buildViews } from "./views.ts";

function today(): ISODate {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` as ISODate;
}

const USAGE = "usage: alfred check [<area>] [--quick] | build | hook | get <id> | why <id> | diff <a>[..<b>]  [--memory memory/index.ts]";

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const mi = args.indexOf("--memory");
  const entry = resolve(mi >= 0 ? (args.splice(mi, 2)[1] ?? "") : "memory/index.ts");
  const qi = args.indexOf("--quick");
  const quick = qi >= 0 && args.splice(qi, 1).length > 0;
  const [cmd, arg] = args;
  if (!cmd || !["check", "build", "hook", "get", "why", "diff"].includes(cmd) || (["get", "why", "diff"].includes(cmd) && !arg)) {
    console.error(USAGE);
    return 2;
  }

  const memoryDirAbs = dirname(entry);
  const base = dirname(memoryDirAbs);
  if (cmd === "hook") {
    // Portable (K15): paths relative to the repository root, so the hook works wherever the folder is moved.
    const cli = relative(base, fileURLToPath(import.meta.url));
    const hook = join(base, ".git", "hooks", "pre-commit");
    const rel = join(basename(memoryDirAbs), basename(entry));
    const typecheck = "if [ -f tsconfig.json ] && [ -x node_modules/.bin/tsc ]; then node_modules/.bin/tsc --noEmit || exit 1; fi";
    await writeFile(hook, `#!/bin/sh\n# installed by alfredish\ncd "$(git rev-parse --show-toplevel)" || exit 1\n${typecheck}\nnode "${cli}" check --memory "${rel}" || { echo "alfred check is red: commit stopped"; exit 1; }\n`);
    await chmod(hook, 0o755);
    console.log(`installed: ${hook}`);
    return 0;
  }
  const ctx = nodeContext(base);
  const repo = { base, memoryDir: basename(memoryDirAbs), ctx };
  const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const roots = Object.values(mod);
  const { defs } = collect(roots);
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
  const report = await compile(roots, { today: day, ctx, fileExists: ctx.fileExists, probeCache, ...(scope && { scope }) });
  await saveProbeCache(base, probeCache);
  const snap = snapshot(defs);

  switch (cmd) {
    case "build": {
      const changed = await writeViews(buildViews(defs, report, day), snap, repo);
      console.log(changed.length ? changed.map((c) => `written: ${c}`).join("\n") : "no changes");
      return 0;
    }
    case "check": {
      report.issues.push(
        ...(await checkViews(buildViews(defs, report, day), snap, repo)),
        ...(await checkPast(snap, day, repo)),
        ...(await checkImports(repo)),
      );
      console.log(formatCheck(report));
      return report.issues.some((i) => i.status === "red") ? 1 : 0;
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
