// Alfredish compiler: evaluates every definition and applies the SPEC §7 rules that need no repository.
import type { Def, Duration, Finding, ISODate, PresentDef, ProbeContext, Status, Verify } from "./types.ts";

export interface Issue {
  id: string;
  status: Exclude<Status, "green">;
  rule: string;
  message: string;
}

export interface DefResult {
  def: Def;
  status: Status;
  reasons: string[];
}

export interface Report {
  results: Map<string, DefResult>;
  issues: Issue[];
  counts: { definitions: number; tests: number; parked: number };
}

export interface CompileOptions {
  today: ISODate;
  ctx: ProbeContext;
  /** Used to check that research rawData files exist. */
  fileExists?: (path: string) => Promise<boolean>;
}

const PRESENT = new Set(["fact", "claim", "decision", "promise", "goal", "idea", "account", "asset", "rule"]);
const KINDS = new Set([...PRESENT, "session", "event", "research"]);
const ROOTS = new Set(["decision", "claim", "goal", "promise", "rule", "asset", "idea"]);
const RANK: Record<Status, number> = { green: 0, yellow: 1, unknown: 2, red: 3 };

export const worst = (a: Status, b: Status): Status => (RANK[a] >= RANK[b] ? a : b);
export const isPresent = (d: Def): d is PresentDef => PRESENT.has(d.kind);
export const isDef = (x: unknown): x is Def =>
  typeof x === "object" && x !== null && "kind" in x && "id" in x && typeof (x as { id: unknown }).id === "string" && KINDS.has((x as { kind: string }).kind);

export const days = (d: Duration): number => Number(d.slice(0, -1));
export const ageInDays = (from: ISODate, today: ISODate): number => Math.floor((Date.parse(today) - Date.parse(from)) / 86_400_000);

/** K8: expired → red, last 20% of the window → yellow. */
export function ttlStatus(from: ISODate, ttl: Duration, today: ISODate): { status: Status; reason?: string } {
  const age = ageInDays(from, today);
  const limit = days(ttl);
  if (age > limit) return { status: "red", reason: `expired (${from}, ttl ${ttl})` };
  if (age > limit * 0.8) return { status: "yellow", reason: `expires soon (${limit - age} days left)` };
  return { status: "green" };
}

// ---- graph ----

function verifyDeps(v: Verify): Def[] {
  if (v.kind === "derived") return [...v.from];
  if (v.kind === "fromFinding" && v.finding.research) return [v.finding.research];
  return [];
}

/** Dependencies whose red status propagates (K3). */
export function deps(d: Def): Def[] {
  const own = isPresent(d) ? verifyDeps(d.verify) : [];
  switch (d.kind) {
    case "claim":
    case "decision":
      return [...d.restsOn, ...own];
    case "asset":
      return [d.on, ...own];
    case "goal":
    case "promise":
      return [...d.requires, ...own];
    case "idea":
      return []; // a revisit condition is not a dependency: ideas are never red
    default:
      return own;
  }
}

function children(d: Def): Def[] {
  const out: Def[] = d.kind === "session" ? [] : [d.origin];
  out.push(...deps(d));
  if (d.kind === "idea") out.push(...verifyDeps(d.verify));
  if (d.kind === "promise" && typeof d.due !== "string") out.push(...verifyDeps(d.due));
  if (d.kind === "decision" && d.supersedes) out.push(d.supersedes);
  if (d.kind === "event") out.push(...d.affects);
  if (d.kind === "fact" && d.parked) out.push(...verifyDeps(d.parked.revisitWhen));
  if (d.kind === "research") for (const f of Object.values(d.findings)) if (f.parked) out.push(...verifyDeps(f.parked.revisitWhen));
  return out;
}

export function collect(roots: readonly unknown[]): { defs: Def[]; issues: Issue[] } {
  const seen = new Set<Def>();
  const byId = new Map<string, Def>();
  const issues: Issue[] = [];
  const visit = (d: Def) => {
    if (seen.has(d)) return;
    seen.add(d);
    const prev = byId.get(d.id);
    if (prev && prev !== d) issues.push({ id: d.id, status: "red", rule: "id", message: "two different definitions share this id" });
    byId.set(d.id, d);
    for (const c of children(d)) visit(c);
  };
  for (const r of roots) if (isDef(r)) visit(r);
  return { defs: [...seen], issues };
}

// ---- evaluation ----

export async function evalVerify(v: Verify, today: ISODate, ctx: ProbeContext): Promise<{ status: Status; reason?: string }> {
  switch (v.kind) {
    case "probe":
      try {
        const r = await v.run(ctx);
        return r.ok ? { status: "green" } : { status: "red", reason: `${v.describe}: ${r.detail ?? "failed"}` };
      } catch (e) {
        return { status: "unknown", reason: `${v.describe}: could not look (${(e as Error).message})` };
      }
    case "agentProbe":
      if (!v.last) return { status: "red", reason: `${v.describe}: never verified` };
      if (!v.last.ok) return { status: "red", reason: `${v.describe}: failed at last look (${v.last.at})` };
      return ttlStatus(v.last.at, v.ttl, today);
    case "source":
      return ttlStatus(v.readAt, v.ttl, today);
    case "fromFinding":
      return v.finding.research ? ttlStatus(v.finding.research.at, v.ttl, today) : { status: "red", reason: "finding is not part of a research" };
    case "review":
      return ttlStatus(v.at, v.every, today);
    case "confirm":
      return v.at ? { status: "green" } : { status: "red", reason: `waiting for ${v.by} to confirm` };
    case "after":
      return today >= v.date ? { status: "green" } : { status: "red", reason: `not before ${v.date}` };
    case "derived":
      return { status: "green" }; // inputs are handled by propagation (K3)
  }
}

/** A condition "comes true" when satisfied; a derived condition when every input is satisfied (SPEC §5). */
export async function conditionStatus(v: Verify, today: ISODate, ctx: ProbeContext, seen = new Set<Def>()): Promise<Status> {
  if (v.kind !== "derived") return (await evalVerify(v, today, ctx)).status;
  let unknown = false;
  for (const input of v.from) {
    if (!isPresent(input) || seen.has(input)) continue;
    seen.add(input);
    const s = await conditionStatus(input.verify, today, ctx, seen);
    if (s === "red" || s === "yellow") return "red";
    if (s === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "green";
}

function deadline(start: ISODate, end: ISODate, today: ISODate, label: string): { status: Status; reason?: string } {
  const total = Math.max(1, ageInDays(start, end));
  const left = ageInDays(today, end);
  if (left < 0) return { status: "red", reason: `${label} passed (${end})` };
  if (left < total * 0.2) return { status: "yellow", reason: `${label} soon (${left} days left)` };
  return { status: "green" };
}

async function ownStatus(d: Def, o: CompileOptions): Promise<{ status: Status; reasons: string[] }> {
  const reasons: string[] = [];
  if (d.kind === "research") {
    let status: Status = "green";
    for (const p of d.rawData) {
      if (o.fileExists && !(await o.fileExists(p))) {
        status = "red";
        reasons.push(`raw data missing: ${p}`);
      }
    }
    return { status, reasons };
  }
  if (!isPresent(d)) return { status: "green", reasons };

  if (d.kind === "idea") {
    // Never red: the revisit condition coming true is the signal.
    const c = await conditionStatus(d.verify, o.today, o.ctx);
    if (c === "green") return { status: "yellow", reasons: [`revisit: ${d.reason}`] };
    return { status: c === "unknown" ? "unknown" : "green", reasons };
  }
  const v = await evalVerify(d.verify, o.today, o.ctx);
  switch (d.kind) {
    case "promise":
    case "goal": {
      if (v.status === "green") return { status: "green", reasons };
      if (d.kind === "goal") {
        const w = deadline(d.origin.at, d.phase.ends, o.today, "phase end");
        return { status: w.status, reasons: w.reason ? [w.reason] : [] };
      }
      if (typeof d.due === "string") {
        const w = deadline(d.origin.at, d.due, o.today, "due date");
        return { status: w.status, reasons: w.reason ? [w.reason] : [] };
      }
      const c = await conditionStatus(d.due, o.today, o.ctx);
      if (c === "green") return { status: "red", reasons: ["due condition came true and it is not done"] };
      return { status: c === "unknown" ? "unknown" : "green", reasons };
    }
    default: {
      let status = v.status;
      if (v.reason) reasons.push(v.reason);
      if (d.kind === "claim") {
        for (const r of d.restsOn) {
          if (r.kind === "fact" && r.evidence !== "live" && r.evidence !== "source") {
            status = "red";
            reasons.push(`K4: fact ${r.id} has evidence "${r.evidence}" (needs live/source)`);
          }
        }
      }
      if (d.kind === "decision" && d.verify.kind !== "review") {
        const rv = ttlStatus(d.origin.at, d.review, o.today);
        if (rv.status !== "green") {
          status = worst(status, rv.status);
          reasons.push(`re-approval ${rv.reason}`);
        }
      }
      return { status, reasons };
    }
  }
}

export async function compile(roots: readonly unknown[], o: CompileOptions): Promise<Report> {
  const { defs, issues } = collect(roots);
  const own = new Map<Def, { status: Status; reasons: string[] }>();
  let tests = 0;
  for (const d of defs) {
    if (isPresent(d)) tests++;
    own.set(d, await ownStatus(d, o));
  }

  // K3: propagation.
  const final = new Map<Def, DefResult>();
  const resolving = new Set<Def>();
  const resolve = (d: Def): DefResult => {
    const done = final.get(d);
    if (done) return done;
    const mine = own.get(d) ?? { status: "green" as Status, reasons: [] };
    if (resolving.has(d)) return { def: d, ...mine };
    resolving.add(d);
    let status = mine.status;
    const reasons = [...mine.reasons];
    for (const dep of deps(d)) {
      const r = resolve(dep);
      if (r.status !== "green") {
        status = worst(status, r.status);
        reasons.push(`depends on ${r.status}: ${dep.id}`);
      }
    }
    resolving.delete(d);
    const res = { def: d, status, reasons };
    final.set(d, res);
    return res;
  };
  for (const d of defs) resolve(d);

  // K12: unused knowledge.
  const used = new Set<Def>();
  const usedFindings = new Set<Finding>();
  const usedRaw = new Set<string>();
  const markUsed = (d: Def) => {
    if (used.has(d)) return;
    used.add(d);
    if (isPresent(d) && d.verify.kind === "fromFinding") usedFindings.add(d.verify.finding);
    for (const x of deps(d)) markUsed(x);
  };
  for (const d of defs) if (ROOTS.has(d.kind)) markUsed(d);
  let parked = 0;
  const parkedCheck = async (id: string, p: { reason: string; revisitWhen: Verify }) => {
    parked++;
    if ((await conditionStatus(p.revisitWhen, o.today, o.ctx)) === "green") issues.push({ id, status: "yellow", rule: "K12", message: `parked, revisit condition came true: ${p.reason}` });
  };
  for (const d of defs) {
    if (d.kind === "fact" && !used.has(d)) {
      if (d.parked) await parkedCheck(d.id, d.parked);
      else issues.push({ id: d.id, status: "red", rule: "K12", message: "unused (supports nothing and is not parked)" });
    }
    if (d.kind === "account" && !used.has(d)) issues.push({ id: d.id, status: "red", rule: "K12", message: "no asset uses this account" });
    if (d.kind === "research") {
      for (const f of Object.values(d.findings)) {
        if (f.source && typeof f.source !== "string") usedRaw.add(f.source.path);
        if (usedFindings.has(f)) continue;
        if (f.parked) await parkedCheck(`${d.id}#${f.key}`, f.parked);
        else issues.push({ id: `${d.id}#${f.key}`, status: "red", rule: "K12", message: "finding unused and not parked" });
      }
      for (const p of d.rawData) {
        if (!usedRaw.has(p)) issues.push({ id: `${d.id}:${p}`, status: "red", rule: "K12", message: "raw data is the source of no finding" });
      }
    }
  }

  // K10 secrets, K15 local paths.
  for (const d of defs) {
    for (const s of strings(d)) {
      const secret = SECRET_PATTERNS.find(([, re]) => re.test(s));
      if (secret) issues.push({ id: d.id, status: "red", rule: "K10", message: `looks like a secret: ${secret[0]}` });
      const path = LOCAL_PATH.exec(s);
      if (path) {
        issues.push({ id: d.id, status: "red", rule: "K15", message: `local path "${path[0].trim()}": what should be written instead (repo, tracker, cloud or site address)?` });
      }
    }
  }

  const results = new Map<string, DefResult>();
  for (const r of final.values()) {
    results.set(r.def.id, r);
    if (r.status !== "green") issues.push({ id: r.def.id, status: r.status, rule: "status", message: r.reasons.join(" · ") });
  }
  issues.sort((a, b) => RANK[b.status] - RANK[a.status] || a.id.localeCompare(b.id));
  return { results, issues, counts: { definitions: defs.length, tests, parked } };
}

// ---- K10 / K15 scanning ----

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

const LOCAL_PATH = /(?:^|[\s"'`(])(?:\/Users\/|\/home\/|~\/|[A-Za-z]:\\)[^\s"'`)]*/;

const LINK_KEYS = new Set(["origin", "research", "restsOn", "requires", "on", "from", "affects", "supersedes", "finding"]);

/** Every string written in this definition (not in linked definitions, not inside owner-confirmed local()). */
function strings(d: Def): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number) => {
    if (depth > 5 || x === null || seen.has(x)) return;
    if (typeof x === "string") {
      out.push(x);
      return;
    }
    if (typeof x !== "object") return;
    seen.add(x);
    const kind = (x as { kind?: unknown }).kind;
    if (kind === "local" || (kind === "probe" && "local" in x)) return;
    for (const [k, v] of Object.entries(x)) if (!LINK_KEYS.has(k)) walk(v, depth + 1);
  };
  walk(d, 0);
  return out;
}
