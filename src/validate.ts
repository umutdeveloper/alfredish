// K16: every promise the type level makes is checked again on the loaded definitions (type checks can be switched off).
// shapeProblems never throws: it is what keeps a malformed definition from crashing the rest of the compiler.
import type { Def } from "./types.ts";

const KINDS = new Set(["fact", "claim", "decision", "promise", "goal", "idea", "account", "asset", "rule", "session", "event", "research", "key"]);
const PRESENT = new Set(["fact", "claim", "decision", "promise", "goal", "idea", "account", "asset", "rule"]);
const EVIDENCE = new Set(["live", "source", "human", "research", "codeRead", "secondHand"]);
const CONDITIONS = new Set(["probe", "confirm", "after", "derived"]);
const VERIFIES = new Set([...CONDITIONS, "agentProbe", "source", "fromFinding", "review"]);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isDate = (x: unknown) => isStr(x) && /^\d{4}-\d{2}-\d{2}$/.test(x);
const isDuration = (x: unknown) => isStr(x) && /^\d+d$/.test(x);
/** A definition-shaped object: something a link may point to. */
export const looksLikeDef = (x: unknown): x is Obj => isObj(x) && isStr(x["id"]) && isStr(x["kind"]);
const isDefOf = (x: unknown, kinds?: Set<string>) => looksLikeDef(x) && KINDS.has(x["kind"] as string) && (!kinds || kinds.has(x["kind"] as string));

const FIX = {
  verify: "give it a test (SPEC §5): a probe, review, source, fromFinding, agentProbe, confirm, after or derived",
  evidence: `set evidence to one of ${[...EVIDENCE].join(", ")}`,
  origin: "set origin to the session it was written in",
  link: "link only to definitions (import the exported definition)",
  location: 'write url("https://…") or an owner-confirmed local(path, { confirmedBy: "owner", at })',
  date: "write the date as YYYY-MM-DD",
  string: "give it a text value",
};

function verifyProblems(v: unknown, field: string, onlyConditions = false): string[] {
  if (!isObj(v) || !isStr(v["kind"]) || !VERIFIES.has(v["kind"])) return [`${field} is missing or not a verification — ${FIX.verify}`];
  const k = v["kind"];
  if (onlyConditions && !CONDITIONS.has(k)) return [`${field} must be a condition (probe, confirm, after or derived), not ${k}`];
  const out: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) out.push(`${field} (${k}): ${what}`); };
  if (k === "probe") need(isStr(v["describe"]) && typeof v["run"] === "function", "needs a description and a test to run");
  if (k === "agentProbe") need(isStr(v["describe"]) && isDuration(v["ttl"]), "needs a description and a ttl like 30d");
  if (k === "source") need(isStr(v["url"]) && isDate(v["readAt"]) && isDuration(v["ttl"]), "needs url, readAt (YYYY-MM-DD) and ttl");
  if (k === "fromFinding") need(isObj(v["finding"]) && isDefOf((v["finding"] as Obj)["research"], new Set(["research"])) && isDuration(v["ttl"]), "needs a finding of a research and a ttl");
  if (k === "review") need(v["by"] === "owner" && isDate(v["at"]) && isDuration(v["every"]), 'needs by: "owner", at (YYYY-MM-DD) and every (like 90d)');
  if (k === "confirm") need(v["by"] === "owner" && (v["at"] === undefined || isDate(v["at"])), 'needs by: "owner" and, once confirmed, at (YYYY-MM-DD)');
  if (k === "after") need(isDate(v["date"]), FIX.date);
  if (k === "derived") need(Array.isArray(v["from"]) && v["from"].every((x) => isDefOf(x)), `derives only from definitions — ${FIX.link}`);
  return out;
}

const isRetired = (y: unknown) => isObj(y) && y["kind"] === "retired" && isStr(y["id"]);
const linkList = (x: unknown, field: string, required: boolean, retiredOk = false): string[] => {
  if (x === undefined) return required ? [`${field} is missing — write [] when there are none`] : [];
  if (!Array.isArray(x)) return [`${field} is not a list — ${FIX.link}`];
  return x.flatMap((y, i) => (isDefOf(y) || (retiredOk && isRetired(y)) ? [] : [`${field}[${i}] is not a definition — ${FIX.link}`]));
};

const location = (x: unknown, field: string): string[] => {
  if (isObj(x) && x["kind"] === "url" && isStr(x["href"]) && /^https?:\/\//.test(x["href"])) return [];
  if (isObj(x) && x["kind"] === "local" && isStr(x["path"]) && x["confirmedBy"] === "owner" && isDate(x["at"])) return [];
  return [`${field} is not url() or local() — ${FIX.location}`];
};

/** Problems with one definition's shape; [] = well-formed. Each names the field and says the fix. */
export function shapeProblems(x: unknown): string[] {
  if (!looksLikeDef(x)) return ["not a definition: it needs a string id and a kind"];
  const d = x;
  const kind = d["kind"] as string;
  if (!KINDS.has(kind)) return [`kind "${kind}" is not an Alfredish kind (${[...KINDS].join(", ")})`];
  const out: string[] = [];
  const str = (f: string) => { if (!isStr(d[f])) out.push(`${f} is missing — ${FIX.string}`); };
  if ((d["id"] as string).trim() === "") out.push("id is empty");
  str("title");
  if (kind !== "session" && !isDefOf(d["origin"], new Set(["session"]))) out.push(`origin is not a session — ${FIX.origin}`);
  if (PRESENT.has(kind)) {
    out.push(...verifyProblems(d["verify"], "verify", kind === "idea"));
    if (!EVIDENCE.has(d["evidence"] as string)) out.push(`evidence is missing or unknown — ${FIX.evidence}`);
  }
  switch (kind) {
    case "session":
      if (!isDate(d["at"])) out.push(`at — ${FIX.date}`);
      str("topic");
      if (!Array.isArray(d["questions"]) || !d["questions"].every(isStr)) out.push("questions must be a list of texts");
      if (d["changes"] !== undefined && !(isObj(d["changes"]) && Object.values(d["changes"]).every(isStr))) out.push("changes must map definition ids to one-line reasons");
      break;
    case "event":
      if (!isDate(d["at"])) out.push(`at — ${FIX.date}`);
      str("text");
      out.push(...linkList(d["affects"], "affects", true, true));
      if (d["retires"] !== undefined && !(Array.isArray(d["retires"]) && d["retires"].every(isStr))) out.push("retires must be a list of definition ids");
      if (d["distinctFrom"] !== undefined && !(Array.isArray(d["distinctFrom"]) && d["distinctFrom"].every((x) => isDefOf(x, new Set(["event"]))))) out.push("distinctFrom must be a list of events");
      if (d["corrects"] !== undefined && !isDefOf(d["corrects"], new Set(["event"]))) out.push("corrects must be an event");
      break;
    case "research": {
      if (!isDate(d["at"])) out.push(`at — ${FIX.date}`);
      str("question");
      str("readWhen");
      if (!Array.isArray(d["rawData"]) || !d["rawData"].every(isStr)) out.push("rawData must be a list of file paths");
      if (!isObj(d["findings"])) out.push("findings must be an object of findings");
      else for (const [key, f] of Object.entries(d["findings"])) {
        if (!isObj(f) || !isStr(f["text"])) out.push(`finding ${key} needs a text`);
        else if (f["parked"] !== undefined) {
          const p = f["parked"];
          if (!isObj(p) || !isStr(p["reason"])) out.push(`finding ${key}: parked needs a reason`);
          else out.push(...verifyProblems(p["revisitWhen"], `finding ${key}: revisitWhen`, true));
        }
      }
      break;
    }
    case "key": {
      const camel = /^[a-z][A-Za-z0-9]*$/;
      if (!isStr(d["subject"]) || !camel.test(d["subject"])) out.push("subject must be a lowerCamelCase name (e.g. ada)");
      if (!isStr(d["name"]) || !camel.test(d["name"])) out.push("name must be a lowerCamelCase name (e.g. budgetCap)");
      if (isStr(d["subject"]) && isStr(d["name"]) && d["id"] !== `key:${d["subject"]}.${d["name"]}`) out.push("id must be key:subject.name — build keys with key()");
      if (!["amount", "date", "text", "list", "boolean", "number", "url"].includes(d["valueType"] as string)) out.push("valueType must be amount, date, text, list, boolean, number or url");
      str("describe");
      if (d["distinctFrom"] !== undefined) {
        if (!Array.isArray(d["distinctFrom"])) out.push("distinctFrom must be a list of keys");
        else d["distinctFrom"].forEach((x, i) => { if (!isDefOf(x, new Set(["key"]))) out.push(`distinctFrom[${i}] is not a key — ${FIX.link}`); });
      }
      break;
    }
    case "fact":
      if (d["key"] === undefined) out.push("key is missing — give the fact the key of the property it states (see alfred keys <subject>)");
      else if (!isDefOf(d["key"], new Set(["key"]))) out.push(`key is not a key — ${FIX.link}`);
      if (!["string", "number", "boolean"].includes(typeof d["value"])) out.push("value is missing — give the fact a value");
      if (d["parked"] !== undefined) {
        const p = d["parked"];
        if (!isObj(p) || !isStr(p["reason"])) out.push("parked needs a reason");
        else out.push(...verifyProblems(p["revisitWhen"], "parked.revisitWhen", true));
      }
      break;
    case "claim":
      str("text");
      out.push(...location(d["where"], "where"), ...linkList(d["restsOn"], "restsOn", true));
      break;
    case "decision":
      out.push(...linkList(d["restsOn"], "restsOn", true));
      if (!isDuration(d["review"])) out.push("review is missing — give a re-approval interval like 90d");
      if (d["supersedes"] !== undefined && !isDefOf(d["supersedes"], new Set(["decision"]))) out.push(`supersedes is not a decision — ${FIX.link}`);
      break;
    case "promise":
      if (d["owner"] !== "owner" && d["owner"] !== "agent") out.push('owner must be "owner" or "agent"');
      if (!isDate(d["due"])) out.push(...verifyProblems(d["due"], "due (a date or a condition)", true));
      out.push(...linkList(d["requires"], "requires", true));
      break;
    case "goal":
      if (!isObj(d["phase"]) || !isStr(d["phase"]["name"]) || !isDate(d["phase"]["ends"])) out.push("phase needs a name and ends (YYYY-MM-DD)");
      out.push(...linkList(d["requires"], "requires", true));
      break;
    case "idea":
      str("text");
      str("reason");
      out.push(...linkList(d["basedOn"], "basedOn", false));
      break;
    case "account":
      str("service");
      str("login");
      if (d["owner"] !== "owner" && d["owner"] !== "agent") out.push('owner must be "owner" or "agent"');
      if (!["browserSession", "apiToken", "none"].includes(d["agentAccess"] as string)) out.push("agentAccess must be browserSession, apiToken or none");
      break;
    case "asset":
      if (!isDefOf(d["on"], new Set(["account"]))) out.push(`on is not an account — ${FIX.link}`);
      str("desired");
      out.push(...location(d["location"], "location"));
      break;
    case "rule":
      str("text");
      str("appliesTo");
      out.push(...linkList(d["restsOn"], "restsOn", false));
      break;
  }
  return out;
}

/** True when the definition can be traversed and evaluated without crashing. */
export const wellFormed = (d: Def) => shapeProblems(d).length === 0;
