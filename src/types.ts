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

/** A path the owner confirmed exists on one machine only. Anything else must be a canonical address. */
export interface LocalPath {
  kind: "local";
  path: string;
  confirmedBy: "owner";
  at: ISODate;
}

// ---- verification (SPEC §5) ----

export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

export interface ProbeContext {
  fetchText(url: string): Promise<{ status: number; headers: Headers; body: string }>;
  fileExists(path: string): Promise<boolean>;
  run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string }>;
}

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

export type Verify = Condition | AgentProbeVerify | SourceVerify | FromFindingVerify | ReviewVerify;

// ---- past-tense types ----

export interface SessionDef {
  kind: "session";
  id: string;
  title: string;
  at: ISODate;
  topic: string;
  questions: readonly string[];
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

export interface EventDef {
  kind: "event";
  id: string;
  title: string;
  origin: SessionDef;
  at: ISODate;
  text: string;
  affects: readonly Def[];
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
}

/** K4: facts behind a claim must be live/source; our own choices (decisions, rules…) may back a claim. */
export type ClaimDependency = FactDef<PublicEvidence> | Exclude<PresentDef, FactDef>;

export interface ClaimDef<E extends Evidence = Evidence> extends Present<"claim", E> {
  text: string;
  where: string;
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
  // verify === revisitWhen (a Condition)
}

export interface AccountDef<E extends Evidence = Evidence> extends Present<"account", E> {
  service: string;
  owner: Party;
  login: string;
  agentAccess: "browserSession" | "apiToken" | "none";
}

export interface AssetDef<E extends Evidence = Evidence> extends Present<"asset", E> {
  on: AccountDef;
  desired: string;
  location: string | LocalPath;
}

export interface RuleDef<E extends Evidence = Evidence> extends Present<"rule", E> {
  text: string;
  appliesTo: string;
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
  | RuleDef<E>;

export type PastDef = SessionDef | EventDef | ResearchDef;
export type Def = PresentDef | PastDef;
