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
  RetiredRef,
  LinkDef,
} from "./types.ts";

type Spec<T> = Omit<T, "kind">;

// ---- past tense ----

export const session = (d: Spec<SessionDef>): SessionDef => ({ kind: "session", ...d });

export const event = (d: Omit<Spec<EventDef>, "affects"> & { affects?: readonly (Def | RetiredRef)[] }): EventDef => ({
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
/** §9.2: rest on another memory's definition as its owner signed it (`alfred link <memory> <id>` prints hash and evidence). */
// A link to a rule nothing rests on may follow the rule's latest signed wording instead (`follows: true`, no hash).
export const link = <E extends Evidence>(d: { id: string; title: string; origin: SessionDef; memory: string; target: string; kind: string; evidence: E } & ({ hash: string; follows?: never } | { follows: true; hash?: never })): LinkDef<E> => ({
  kind: "link", id: d.id, title: d.title, origin: d.origin, memory: d.memory, target: d.target, evidence: d.evidence,
  verify: { kind: "linked", memory: d.memory, target: d.target, targetKind: d.kind, hash: d.hash ?? "", evidence: d.evidence, ...(d.follows && { follows: true as const }) },
});

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

/** Names a retired definition (K20) in a past event's `affects`, so the event stays exactly as it was (K5). */
export const retired = (id: string): RetiredRef => ({ kind: "retired", id });

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
    contains: (text: string): ProbeVerify => {
      const v = probe(`file ${path} contains "${text}"`, async (ctx) => {
        const t = ctx.readText ? await ctx.readText(path) : undefined;
        if (t === undefined) return { ok: false, detail: "cannot be read" };
        return t.includes(text) ? { ok: true } : { ok: false, detail: `"${text}" not found` };
      });
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

/** IANA's list of the registries' RDAP servers, by top-level domain (RFC 9224). */
export const IANA_RDAP_DNS = "https://data.iana.org/rdap/dns.json";

const isRealDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A domain's registration end, from its registry over RDAP (whois's structured successor), or why it is unknown. */
async function rdapExpiry(ctx: ProbeContext, name: string): Promise<{ at: string } | { why: string }> {
  const tld = name.toLowerCase().split(".").pop() ?? "";
  const boot = await ctx.fetchText(IANA_RDAP_DNS);
  const list = parseJson(boot.body);
  const services = isObject(list) ? list["services"] : undefined;
  let server: string | undefined;
  for (const s of Array.isArray(services) ? services : []) {
    if (Array.isArray(s) && Array.isArray(s[0]) && s[0].includes(tld) && Array.isArray(s[1]) && typeof s[1][0] === "string") server = s[1][0];
  }
  if (!server) return { why: `no RDAP server for .${tld} in IANA's list` };
  const r = await ctx.fetchText(`${server.replace(/\/?$/, "/")}domain/${name}`);
  if (r.status !== 200) return { why: `RDAP answered ${r.status}` };
  const body = parseJson(r.body);
  const events = isObject(body) ? body["events"] : undefined;
  for (const e of Array.isArray(events) ? events : []) {
    if (isObject(e) && e["eventAction"] === "expiration" && typeof e["eventDate"] === "string" && !Number.isNaN(Date.parse(e["eventDate"]))) return { at: e["eventDate"] };
  }
  return { why: "RDAP gives no expiration date" };
}

/** A domain's registration, compared as dates (never as text). */
export const domain = (name: string) => ({
  expiresOnOrAfter: (date: ISODate) => {
    if (!isRealDate(date)) throw new Error(`domain(${name}).expiresOnOrAfter(): not a real date: ${date}`);
    return probe(`domain ${name} registration ends on or after ${date} (RDAP)`, async (ctx) => {
      const exp = await rdapExpiry(ctx, name);
      if ("why" in exp) return { ok: false, detail: exp.why };
      return Date.parse(exp.at) >= Date.parse(`${date}T00:00:00Z`) ? { ok: true } : { ok: false, detail: `ends ${exp.at}` };
    });
  },
});

/** `gh api -i` output: the HTTP status and the (jq-filtered) body; undefined when gh gave no HTTP answer. */
function ghAnswer(stdout: string): { status: number; body: string } | undefined {
  const m = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (!m) return undefined;
  const gap = stdout.search(/\r?\n\r?\n/);
  return { status: Number(m[1]), body: gap < 0 ? "" : stdout.slice(gap).trim() };
}
const ghCall = async (ctx: ProbeContext, path: string, jq: string) => ghAnswer((await ctx.run("gh", ["api", "-i", path, "--jq", jq])).stdout);

/** A GitHub repository, through the owner's gh login (so private repositories count). Unknown is never green. */
export const github = (repo: string) => ({
  exists: () =>
    probe(`github ${repo} exists`, async (ctx) => {
      const a = await ghCall(ctx, `repos/${repo}`, ".full_name");
      if (!a) return { ok: false, detail: "no answer from GitHub (gh)" };
      if (a.status === 404) return { ok: false, detail: "not found" };
      if (a.status !== 200) return { ok: false, detail: `GitHub answered ${a.status}` };
      return a.body.toLowerCase() === repo.toLowerCase() ? { ok: true } : { ok: false, detail: `answered as ${a.body || "?"} (renamed or moved)` };
    }),
  isPrivate: () =>
    probe(`github ${repo} is private`, async (ctx) => {
      const a = await ghCall(ctx, `repos/${repo}`, ".private");
      if (!a) return { ok: false, detail: "no answer from GitHub (gh)" };
      if (a.status !== 200) return { ok: false, detail: a.status === 404 ? "not found" : `GitHub answered ${a.status}` };
      return a.body === "true" ? { ok: true } : { ok: false, detail: a.body === "false" ? "the repository is PUBLIC" : `unexpected answer ${a.body}` };
    }),
  absent: () =>
    probe(`github ${repo} is absent`, async (ctx) => {
      const a = await ghCall(ctx, `repos/${repo}`, ".full_name");
      if (!a) return { ok: false, detail: "no answer from GitHub (gh): absence unknown" };
      if (a.status === 404) return { ok: true };
      return a.status === 200 ? { ok: false, detail: `still exists (${a.body || repo})` } : { ok: false, detail: `GitHub answered ${a.status}: absence unknown` };
    }),
  lastCommitTouching: (path: string, sha: string) =>
    probe(`github ${repo} last commit touching ${path} is ${sha}`, async (ctx) => {
      const a = await ghCall(ctx, `repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`, ".[0].sha");
      if (!a || a.status !== 200) return { ok: false, detail: a ? `GitHub answered ${a.status}` : "no answer from GitHub (gh)" };
      return a.body.startsWith(sha) ? { ok: true } : { ok: false, detail: `last is ${a.body.slice(0, 7) || "none"}` };
    }),
});

export type DnsType = "A" | "AAAA" | "CNAME" | "MX" | "NS" | "TXT";

/** DNS answers for `name` (optionally from one name server), with the query's status, or why there is none. */
async function dnsAnswer(ctx: ProbeContext, name: string, type: DnsType, server?: string): Promise<{ status: string; data: string[] } | { why: string }> {
  const r = await ctx.run("dig", ["+noall", "+comments", "+answer", ...(server ? [`@${server}`] : []), type, name]);
  if (r.code !== 0) return { why: `dig failed (exit ${r.code})` };
  const status = /status: ([A-Z]+)/.exec(r.stdout)?.[1];
  if (!status) return { why: "no DNS answer" };
  const data = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 5 && f[2] === "IN" && f[3] === type).map((f) => f.slice(4).join(" ").toLowerCase());
  return { status, data };
}

/** A DNS record set. A value matches when a record contains it (case-insensitive). Unknown is never green. */
export const dns = (name: string, type: DnsType, o: { server?: string } = {}) => {
  const at = o.server ? ` at ${o.server}` : "";
  return {
    contains: (value: string) =>
      probe(`dns ${type} ${name}${at} contains "${value}"`, async (ctx) => {
        const a = await dnsAnswer(ctx, name, type, o.server);
        if ("why" in a) return { ok: false, detail: a.why };
        if (a.status !== "NOERROR") return { ok: false, detail: a.status };
        return a.data.some((d) => d.includes(value.toLowerCase())) ? { ok: true } : { ok: false, detail: a.data.length ? a.data.join(", ").slice(0, 80) : "no records" };
      }),
    lacks: (...values: string[]) =>
      probe(`dns ${type} ${name}${at} lacks ${values.map((v) => `"${v}"`).join(", ")}`, async (ctx) => {
        const a = await dnsAnswer(ctx, name, type, o.server);
        if ("why" in a) return { ok: false, detail: `${a.why}: absence unknown` };
        if (a.status !== "NOERROR" && a.status !== "NXDOMAIN") return { ok: false, detail: `${a.status}: absence unknown` };
        const hit = a.data.find((d) => values.some((v) => d.includes(v.toLowerCase())));
        return hit ? { ok: false, detail: `found ${hit.slice(0, 80)}` } : { ok: true };
      }),
  };
};

/** Several built-in tests that must all pass; its description lists every one (K25). */
export const all = (...tests: ProbeVerify[]) =>
  probe(`all of: ${tests.map((t) => t.describe).join("; ")}`, async (ctx) => {
    for (const t of tests) {
      const r = await t.run(ctx);
      if (!r.ok) return { ok: false, detail: `${t.describe}: ${r.detail ?? "failed"}` };
    }
    return { ok: true };
  });

export const git = (repo: string) => ({
  clean: () =>
    probe(`git ${repo} is clean`, async (ctx) => {
      const r = await ctx.run("git", ["status", "--porcelain"], repo);
      return r.code === 0 && r.stdout.trim() === "" ? { ok: true } : { ok: false, detail: "uncommitted changes" };
    }),
  noRemote: () =>
    probe(`git ${repo} has no remote`, async (ctx) => {
      const r = await ctx.run("git", ["remote"], repo);
      if (r.code !== 0) return { ok: false, detail: "not a git repository" };
      return r.stdout.trim() === "" ? { ok: true } : { ok: false, detail: `remotes: ${r.stdout.trim().split("\n").join(", ")}` };
    }),
  lastCommitMatches: (re: RegExp, describe: string) =>
    probe(`git ${repo} last commit ${describe} (matches ${re})`, async (ctx) => {
      const r = await ctx.run("git", ["log", "-1", "--format=%s"], repo);
      return re.test(r.stdout.trim()) ? { ok: true } : { ok: false, detail: `"${r.stdout.trim()}"` };
    }),
});
