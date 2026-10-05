// Alfredish v0.1 types (SPEC §4–§6).
// Type-level rules: K1 (verify required), K2 (links are imports), K4 (fact dependencies of claims are live/source),
// K13 (origin required), K14 (requires on goal/promise).

export type Evidence = "live" | "source" | "human" | "research" | "codeRead" | "secondHand";
export type PublicEvidence = "live" | "source";
export type Status = "green" | "yellow" | "red" | "unknown";
export type ISODate = `${number}-${number}-${number}`;
export type Duration = `${number}d`;
export type Party = "owner" | "agent";

// ---- locations (SPEC §3) ----

/** A canonical address: an absolute http(s) URL (repo, cloud folder, tracker, site). Built with url(). */
export interface Url {
  kind: "url";
  href: string;
}

/** A path the owner confirmed exists on one machine only. Anything else must be a canonical address. */
export interface LocalPath {
  kind: "local";
  path: string;
  confirmedBy: "owner";
  at: ISODate;
}

/** Where something lives (K15). A plain string does not compile. */
export type Location = Url | LocalPath;

// ---- verification (SPEC §5) ----

export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

/** A definition of another memory as its owner signed it, and its signed content at an earlier hash if there was one. */
export type SignedLookup = { hash: string; data: Readonly<Record<string, unknown>>; was?: Readonly<Record<string, unknown>> } | { why: string };

export interface ProbeContext {
  /** §9.2: reads another memory's signed state (only from memories registered on this machine). */
  signed?(memory: string, id: string, pinned: string): Promise<SignedLookup>;
  fetchText(url: string): Promise<{ status: number; headers: Headers; body: string }>;
  fileExists(path: string): Promise<boolean>;
  /** A file's text (a memory file, or an owner-confirmed local path), or undefined when it cannot be read. */
  readText?(path: string): Promise<string | undefined>;
  run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string }>;
}

/** Results of probes that ran live, by probe description; `at` is an ISO timestamp (SPEC §9). */
export type ProbeCache = Record<string, { status: Status; reason?: string; at: string }>;

export interface ProbeVerify {
  kind: "probe";
  describe: string;
  run(ctx: ProbeContext): Promise<ProbeResult>;
}

export interface AgentProbeVerify {
  kind: "agentProbe";
  describe: string;
  ttl: Duration;
  last?: { ok: boolean; at: ISODate };
}

export interface SourceVerify {
  kind: "source";
  url: string;
  readAt: ISODate;
  ttl: Duration;
}

export interface FromFindingVerify {
  kind: "fromFinding";
  finding: Finding;
  ttl: Duration;
}

export interface ReviewVerify {
  kind: "review";
  by: "owner";
  at: ISODate;
  every: Duration;
}

export interface ConfirmVerify {
  kind: "confirm";
  by: "owner";
  what?: string;
  at?: ISODate;
}

export interface DerivedVerify {
  kind: "derived";
  from: readonly Def[];
}

export interface AfterVerify {
  kind: "after";
  date: ISODate;
}

/** Conditions "come true" when satisfied (SPEC §5). */
export type Condition = ProbeVerify | ConfirmVerify | AfterVerify | DerivedVerify;

/**
 * Another memory's definition, as its owner signed it (§9.2): green while its signed content still has the pinned hash,
 * yellow once it changed, red when it cannot be read.
 */
export interface LinkedVerify {
  kind: "linked";
  memory: string;
  target: string;
  hash: string;
  /** The target's evidence when it was linked; checked against the signed content. */
  evidence: Evidence;
  /** The target's kind (e.g. "account"), checked against the signed content. */
  targetKind: string;
  /** A rule link that follows the target's latest signed wording instead of pinning `hash` (empty then); nothing may rest on it. */
  follows?: true;
}

export type Verify = Condition | AgentProbeVerify | SourceVerify | FromFindingVerify | ReviewVerify | LinkedVerify;

// ---- past-tense types ----

export interface SessionDef {
  kind: "session";
  id: string;
  title: string;
  at: ISODate;
  topic: string;
  questions: readonly string[];
  /** Why each definition changed in this session (§14): one line per id, shown in the owner's approval list. */
  changes?: Readonly<Record<string, string>>;
}

export interface Parked {
  reason: string;
  revisitWhen: Condition;
}

export interface RawRef {
  path: string;
  locator?: string;
}

export interface Finding {
  kind: "finding";
  key: string;
  text: string;
  value?: string | number;
  source?: string | RawRef;
  parked?: Parked;
  research?: ResearchDef; // set by research()
}

export interface ResearchDef {
  kind: "research";
  id: string;
  title: string;
  origin: SessionDef;
  at: ISODate;
  question: string;
  readWhen: string;
  rawData: readonly string[];
  findings: Readonly<Record<string, Finding>>;
}

/** A definition that was retired (K20), named by id from a past event; serialised exactly like the live reference. */
export interface RetiredRef {
  kind: "retired";
  id: string;
}

export interface EventDef {
  kind: "event";
  id: string;
  title: string;
  origin: SessionDef;
  at: ISODate;
  text: string;
  /** What it changed; a definition retired since is named by `retired(id)`, so the past stays as it was (K5, K20). */
  affects: readonly (Def | RetiredRef)[];
  /** Ids of present-tense definitions removed on this event's day (K20). */
  retires?: readonly string[];
  /** K12: findings of past research ("<research id>#<finding>") that support nothing any more, with why; the research stays as it was. */
  parks?: Readonly<Record<string, string>>;
  /** Definitions (past ones too) that moved on this event's day into another memory, where the owner signed them (K5, K20). */
  moves?: { memory: string; ids: readonly string[] };
  /** Past events removed on this event's day because they only retold the kept event `repeatOf` (K32). */
  drops?: readonly { id: string; repeatOf: EventDef }[];
  /** K29: close events (by meaning) it was compared with and that tell another happening; a dropped one is `retired(id)` (K32). */
  distinctFrom?: readonly (EventDef | RetiredRef)[];
  /** K29: the earlier event that told this happening wrongly; this one corrects it. */
  corrects?: EventDef;
}

// ---- present-tense types ----

interface Present<K extends string, E extends Evidence> {
  kind: K;
  id: string;
  title: string;
  origin: SessionDef;
  verify: Verify;
  evidence: E;
}

export interface FactDef<E extends Evidence = Evidence> extends Present<"fact", E> {
  value: string | number | boolean;
  parked?: Parked;
  /** The property this fact gives the value of; required (K22: one present fact per key). */
  key: KeyDef;
}

// ---- vocabulary ----

export type ValueType = "amount" | "date" | "text" | "list" | "boolean" | "number" | "url";

/** A property of a subject (e.g. ada.budgetCap). States nothing about the world, so it has no verify. */
export interface KeyDef {
  kind: "key";
  id: string; // `key:${subject}.${name}` — its own namespace, so a key never collides with a definition id
  title: string;
  origin: SessionDef;
  subject: string;
  name: string;
  valueType: ValueType;
  describe: string;
  /** Keys this one was compared with and is not the same property as (K23). */
  distinctFrom?: readonly KeyDef[];
}

/** K4: facts behind a claim must be live/source; our own choices (decisions, rules…) may back a claim. */
export type ClaimDependency = FactDef<PublicEvidence> | Exclude<PresentDef, FactDef>;

export interface ClaimDef<E extends Evidence = Evidence> extends Present<"claim", E> {
  text: string;
  where: Location;
  restsOn: readonly ClaimDependency[];
}

export interface DecisionDef<E extends Evidence = Evidence> extends Present<"decision", E> {
  restsOn: readonly PresentDef[];
  review: Duration;
  supersedes?: DecisionDef;
}

export interface PromiseDef<E extends Evidence = Evidence> extends Present<"promise", E> {
  owner: Party;
  due: ISODate | Condition;
  requires: readonly PresentDef[]; // K14
}

export interface GoalDef<E extends Evidence = Evidence> extends Present<"goal", E> {
  phase: { name: string; ends: ISODate };
  requires: readonly PresentDef[]; // K14
}

export interface IdeaDef<E extends Evidence = Evidence> extends Present<"idea", E> {
  text: string;
  reason: string;
  basedOn?: readonly PresentDef[]; // counts as use (K12), never propagates
  // verify === revisitWhen (a Condition)
}

export interface AccountDef<E extends Evidence = Evidence> extends Present<"account", E> {
  service: string;
  owner: Party;
  login: string;
  agentAccess: "browserSession" | "apiToken" | "none";
}

export interface AssetDef<E extends Evidence = Evidence> extends Present<"asset", E> {
  /** The account it lives on: in this memory, or another memory's account through a link (§9.2). */
  on: AccountDef | LinkDef;
  desired: string;
  location: Location;
}

/** §9.2: a definition of another memory on this machine that this memory rests on. */
export interface LinkDef<E extends Evidence = Evidence> extends Present<"link", E> {
  memory: string;
  target: string;
}

export interface RuleDef<E extends Evidence = Evidence> extends Present<"rule", E> {
  text: string;
  appliesTo: string;
  restsOn?: readonly PresentDef[];
}

export type PresentDef<E extends Evidence = Evidence> =
  | FactDef<E>
  | ClaimDef<E>
  | DecisionDef<E>
  | PromiseDef<E>
  | GoalDef<E>
  | IdeaDef<E>
  | AccountDef<E>
  | AssetDef<E>
  | RuleDef<E>
  | LinkDef<E>;

export type PastDef = SessionDef | EventDef | ResearchDef;
export type Def = PresentDef | PastDef | KeyDef;
