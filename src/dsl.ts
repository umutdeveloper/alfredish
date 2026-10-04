// Constructors for Alfredish definitions and verifications (SPEC §4–§5).
import type {
  AccountDef,
  AfterVerify,
  AgentProbeVerify,
  AssetDef,
  ClaimDef,
  Condition,
  ConfirmVerify,
  DecisionDef,
  Def,
  DerivedVerify,
  Duration,
  EventDef,
  Evidence,
  FactDef,
  Finding,
  FromFindingVerify,
  GoalDef,
  IdeaDef,
  KeyDef,
  ISODate,
  LocalPath,
  Url,
  ProbeContext,
  ProbeResult,
  ProbeVerify,
  PromiseDef,
  ResearchDef,
  ReviewVerify,
  RuleDef,
  SessionDef,
  SourceVerify,
  Verify,
} from "./types.ts";

type Spec<T> = Omit<T, "kind">;

// ---- past tense ----

export const session = (d: Spec<SessionDef>): SessionDef => ({ kind: "session", ...d });

export const event = (d: Omit<Spec<EventDef>, "affects"> & { affects?: readonly Def[] }): EventDef => ({
  kind: "event",
  ...d,
  affects: d.affects ?? [],
});

export const finding = (d: Omit<Finding, "kind" | "key" | "research">): Finding =>
  ({ kind: "finding", key: "", ...d }) as Finding;

export function research<F extends Record<string, Finding>>(
  d: Omit<Spec<ResearchDef>, "findings" | "rawData"> & { findings: F; rawData?: readonly string[] },
): ResearchDef & { findings: F } {
  const r = { kind: "research" as const, ...d, rawData: d.rawData ?? [] };
  for (const [key, f] of Object.entries(d.findings)) {
    f.key = key;
    f.research = r;
  }
  return r;
}

export const raw = (path: string, locator?: string) => (locator === undefined ? { path } : { path, locator });

// ---- present tense ----

export const fact = <E extends Evidence>(d: Spec<FactDef<E>>): FactDef<E> => ({ kind: "fact", ...d });

/** A property of a subject; id and title are derived: key({ subject: "ada", name: "budgetCap", … }) is key:ada.budgetCap. */
export const key = (d: Omit<KeyDef, "kind" | "id" | "title"> & { title?: string }): KeyDef => ({
  kind: "key",
  id: `key:${d.subject}.${d.name}`,
  title: d.title ?? d.describe,
  ...d,
});
export const claim = <E extends Evidence>(d: Spec<ClaimDef<E>>): ClaimDef<E> => ({ kind: "claim", ...d });
export const decision = <E extends Evidence>(d: Spec<DecisionDef<E>>): DecisionDef<E> => ({ kind: "decision", ...d });
export const account = <E extends Evidence>(d: Spec<AccountDef<E>>): AccountDef<E> => ({ kind: "account", ...d });
export const asset = <E extends Evidence>(d: Spec<AssetDef<E>>): AssetDef<E> => ({ kind: "asset", ...d });
export const rule = <E extends Evidence>(d: Spec<RuleDef<E>>): RuleDef<E> => ({ kind: "rule", ...d });

export const promise = <E extends Evidence>(
  d: Omit<Spec<PromiseDef<E>>, "verify"> & { doneWhen: Verify },
): PromiseDef<E> => {
  const { doneWhen, ...rest } = d;
  return { kind: "promise", ...rest, verify: doneWhen };
};

export const idea = <E extends Evidence>(
  d: Omit<Spec<IdeaDef<E>>, "verify"> & { revisitWhen: Condition },
): IdeaDef<E> => {
  const { revisitWhen, ...rest } = d;
  return { kind: "idea", ...rest, verify: revisitWhen };
};

export const goal = <E extends Evidence>(d: Omit<Spec<GoalDef<E>>, "verify"> & { doneWhen: Verify }): GoalDef<E> => {
  const { doneWhen, ...rest } = d;
  return { kind: "goal", ...rest, verify: doneWhen };
};

// ---- verifications ----

export const probe = (describe: string, run: (ctx: ProbeContext) => Promise<ProbeResult>): ProbeVerify => ({
  kind: "probe",
  describe,
  run,
});

export const agentProbe = (describe: string, ttl: Duration, last?: { ok: boolean; at: ISODate }): AgentProbeVerify =>
  last === undefined ? { kind: "agentProbe", describe, ttl } : { kind: "agentProbe", describe, ttl, last };

export const source = (url: string, o: { readAt: ISODate; ttl: Duration }): SourceVerify => ({ kind: "source", url, ...o });

export const fromFinding = (f: Finding, o: { ttl: Duration }): FromFindingVerify => ({
  kind: "fromFinding",
  finding: f,
  ttl: o.ttl,
});

export const review = (o: { by: "owner"; at: ISODate; every: Duration }): ReviewVerify => ({ kind: "review", ...o });

export const confirm = (o: { by: "owner"; what?: string; at?: ISODate }): ConfirmVerify => ({
  kind: "confirm",
  by: o.by,
  ...(o.what === undefined ? {} : { what: o.what }),
  ...(o.at === undefined ? {} : { at: o.at }),
});

export const after = (date: ISODate): AfterVerify => ({ kind: "after", date });

/** A canonical address (SPEC §3, K15). Only absolute http(s) URLs are accepted. */
export const url = (href: string): Url => {
  let u: URL | undefined;
  try {
    u = new URL(href);
  } catch {
    u = undefined;
  }
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) throw new Error(`url(): not an absolute http(s) address: ${href}`);
  return { kind: "url", href };
};

/** A path the owner confirmed exists on one machine only (SPEC §3, K15). */
export const local = (path: string, o: { confirmedBy: "owner"; at: ISODate }): LocalPath => ({ kind: "local", path, ...o });

export const derived = (from: readonly Def[]): DerivedVerify => ({ kind: "derived", from });

// ---- probe builders ----

export const page = (url: string) => ({
  contains: (text: string) =>
    probe(`page ${url} contains "${text}"`, async (ctx) => {
      const r = await ctx.fetchText(url);
      return r.body.includes(text) ? { ok: true } : { ok: false, detail: `"${text}" not found` };
    }),
  notContains: (text: string) =>
    probe(`page ${url} does not contain "${text}"`, async (ctx) => {
      const r = await ctx.fetchText(url);
      return r.body.includes(text) ? { ok: false, detail: `"${text}" found` } : { ok: true };
    }),
  hasScriptFrom: (host: string) =>
    probe(`page ${url} loads a script from ${host}`, async (ctx) => {
      const r = await ctx.fetchText(url);
      const re = new RegExp(`<script[^>]+src=["'][^"']*${host.replace(/\./g, "\\.")}`, "i");
      return re.test(r.body) ? { ok: true } : { ok: false, detail: `no script from ${host}` };
    }),
});

export const http = (url: string) => ({
  status: (code: number) =>
    probe(`http ${url} → ${code}`, async (ctx) => {
      const r = await ctx.fetchText(url);
      return r.status === code ? { ok: true } : { ok: false, detail: `got ${r.status}` };
    }),
});

export const header = (url: string, name: string) => ({
  contains: (text: string) =>
    probe(`header ${name} of ${url} contains "${text}"`, async (ctx) => {
      const v = (await ctx.fetchText(url)).headers.get(name) ?? "";
      return v.includes(text) ? { ok: true } : { ok: false, detail: v === "" ? `${name} missing` : `"${text}" not in ${name}` };
    }),
  absent: () =>
    probe(`header ${name} of ${url} is absent`, async (ctx) => {
      const v = (await ctx.fetchText(url)).headers.get(name);
      return v === null ? { ok: true } : { ok: false, detail: `${name} present` };
    }),
});

/** A file inside the memory folder (relative path) or an owner-confirmed local path (K15). */
export const file = (p: LocalPath | string) => {
  const path = typeof p === "string" ? p : p.path;
  return {
    exists: (): ProbeVerify => {
      const v = probe(`file ${path} exists`, async (ctx) =>
        (await ctx.fileExists(path)) ? { ok: true } : { ok: false, detail: "missing" },
      );
      return typeof p === "string" ? v : Object.assign(v, { local: p });
    },
  };
};

/** Runs a command; ok when it exits 0 and (optionally) its output matches. */
/** K25: the description carries everything the test does, so a definition's hash covers it. */
const shellWord = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a));
export const cmd = (describe: string, command: string, args: string[], expect?: RegExp) =>
  probe(`${describe} — runs: ${[command, ...args].map(shellWord).join(" ")}${expect ? ` expect ${expect}` : ""}`, async (ctx) => {
    const r = await ctx.run(command, args);
    if (r.code !== 0) return { ok: false, detail: `exit ${r.code}` };
    return !expect || expect.test(r.stdout) ? { ok: true } : { ok: false, detail: r.stdout.trim().slice(0, 80) };
  });

export const git = (repo: string) => ({
  clean: () =>
    probe(`git ${repo} is clean`, async (ctx) => {
      const r = await ctx.run("git", ["status", "--porcelain"], repo);
      return r.code === 0 && r.stdout.trim() === "" ? { ok: true } : { ok: false, detail: "uncommitted changes" };
    }),
  lastCommitMatches: (re: RegExp, describe: string) =>
    probe(`git ${repo} last commit ${describe} (matches ${re})`, async (ctx) => {
      const r = await ctx.run("git", ["log", "-1", "--format=%s"], repo);
      return re.test(r.stdout.trim()) ? { ok: true } : { ok: false, detail: `"${r.stdout.trim()}"` };
    }),
});
