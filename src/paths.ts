// K30: no text in a memory names a path on one machine, except a path the owner confirmed with local(), and that only in
// a test's description. Memories are carried and pushed; a machine path in a title or a decision is a leak and a lie
// on the next machine. The check proves itself on every known path form before it runs.
import type { Issue } from "./compiler.ts";
import type { Snapshot } from "./snapshot.ts";

const PATTERNS = [
  /~\//, // ~/rt
  /\$\{?HOME\}?/, // $HOME/rt, ${HOME}/rt
  /%[A-Z_]+%\\/i, // %USERPROFILE%\rt
  /\b[A-Za-z]:\\/, // C:\Users
  /(^|[\s"'(=,])\.{1,2}\//, // ./rt, ../../rt
  // Absolute paths that belong to one machine start with a known root; a site path (/tech/x) or a project path
  // (/out/x.mp4) does not.
  /(^|[\s"'(=,])\/(Users|home|root|tmp|private|var|etc|opt|usr|mnt|media|Volumes|Library|System|Applications)\//,
];
export const namesMachinePath = (s: string) => PATTERNS.some((p) => p.test(s));

export const MUST_CATCH = ["opened in ~/rt", "in $HOME/rt", "in ${HOME}/rt", "in ../../rt", "in ./rt/git", "in /Users/someone/rt", "at /home/x/y", "under /tmp/anything", "C:\\Users\\x", "%USERPROFILE%\\rt", "/Volumes/disk/x"];
export const MUST_PASS = ["https://umutcakir.com/go-live-check", "repos/umutdeveloper/esik/commits", "Nov 14 / 6-week plan", "$290", "TCP/IP", "w/o cookies", "2.5M civil servants", "projects/realtyme", "vendor/", "pages (/tech/supabase, /tech/bubble)", "output /out/video-XXX.mp4"];

/** Where a confirmed path may appear: the description Alfredish generates of a test that looks at it. */
const TEST_FIELDS = /\.(verify|due)$/;

/**
 * Paths the owner confirmed with local() anywhere in the definitions — also inside a test (`file(local(...))`), whose
 * record keeps only its description.
 */
export function confirmedPaths(defs: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (x: unknown, top: boolean) => {
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    // Another definition is walked on its own turn; marking it seen here would skip it then.
    if (!top && typeof o["id"] === "string" && typeof o["origin"] === "object") return;
    if (seen.has(x)) return;
    seen.add(x);
    if (o["kind"] === "local" && typeof o["path"] === "string" && o["confirmedBy"] === "owner") return void out.add(o["path"]);
    for (const v of Object.values(o)) walk(v, false);
  };
  for (const d of defs) walk(d, true);
  return out;
}

export function checkLocalPaths(snap: Snapshot, alsoConfirmed: ReadonlySet<string> = new Set()): Issue[] {
  const broken = [...MUST_CATCH.filter((s) => !namesMachinePath(s)).map((s) => `missed: ${s}`), ...MUST_PASS.filter(namesMachinePath).map((s) => `false alarm: ${s}`)];
  if (broken.length) return [{ id: "K30", status: "red", rule: "K30", message: `the path check itself is broken: ${broken.join(" · ")}` }];
  const confirmed = new Set<string>(alsoConfirmed);
  const texts: [string, string, string][] = []; // definition id, where, text
  const walk = (id: string, x: unknown, where: string) => {
    if (typeof x === "string") texts.push([id, where, x]);
    else if (Array.isArray(x)) x.forEach((v, i) => walk(id, v, `${where}[${i}]`));
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (o["kind"] === "local" && typeof o["path"] === "string") return void confirmed.add(o["path"]);
      for (const [k, v] of Object.entries(o)) walk(id, v, `${where}.${k}`);
    }
  };
  for (const [id, d] of Object.entries(snap)) walk(id, d.data, id);
  const issues: Issue[] = [];
  for (const [id, where, s] of texts) {
    const t = TEST_FIELDS.test(where) ? [...confirmed].reduce((a, p) => a.split(p).join("<confirmed>"), s) : s;
    if (namesMachinePath(t)) issues.push({ id, status: "red", rule: "K30", message: `${where.slice(id.length + 1)} names a path on one machine ("${s.slice(0, 80)}") — make it a local() the owner confirms and name it, or say it without the path` });
  }
  return issues;
}
