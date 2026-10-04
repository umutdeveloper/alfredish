# Alfredish v0.1 — specification

> Status: approved. Code follows this document.
> This document is the single source of truth for the language. If code and spec disagree, the spec wins and the code is fixed.

## 1. Problem

An AI agent re-reads its memory from files at the start of every session. When those files are free prose:
- the same fact is written in several places; one changes, the others go stale;
- something "set up" may never have been set up (a plan says "check the analytics report monthly"; no analytics exists);
- the world changes but memory does not (a tracker is installed; the site still says "No trackers");
- the agent forgets what it built itself (which account, which project name);
- nobody knows why a piece of text was written, what depends on it, or whether it is still needed;
- recording is a separate chore, and it gets forgotten ("did you write that down?").

Alfredish turns each of these into a compile or test failure.

## 2. Principles

1. **Nothing lives outside the system.** The only hand-written source is definitions (TypeScript). Every readable file
   (status, decisions, promises, session notes, log, research pages, index, agent rules, profile, roadmap, ideas)
   is **generated** from definitions.
2. **Recording is the work itself.** When a decision is made, something is learned or something in the world is changed,
   it is written as a definition. There is no separate "take notes" step; notes are generated.
3. **Rules are structural.** Compile rules work on types, links, git history and tests against the world —
   never on searching text. A rule that would need a text search is either made structural or not made at all.
   (Tests that look at the world, like `page(url).contains("$290")`, check what we say publicly; they are not rules about memory.)
4. **A memory is one portable folder.** It works on any machine with Node: it carries a pinned copy of `alfredish`
   and refers to things by where they really live (§3), not by paths on one machine.
5. Knowledge is in one of two tenses:

| Tense | What | Can it go stale? | Rule |
|---|---|---|---|
| **Past** (`event`, `session`, `research`) | What happened, what was found that day | No — "on that day it was so" stays true | Immutable once its day has passed |
| **Present** (all other types) | "This is how it is now" | Yes | Does not compile without a test |

A past finding that is still relied on today becomes a present-tense `fact`, linked to the finding with an expiry.

## 3. Form

- Alfredish is embedded in TypeScript. There is no separate syntax or parser.
- Types, required fields and links are checked by the TypeScript type system. Tests run with Vitest.
- Two kinds of repositories:
  - `alfredish`: the language itself (types, verifications, compiler, CLI). Code only, no personal data.
  - a **memory**: definitions written in Alfredish, owned by one person, with a pinned copy of `alfredish` inside it.
- A definition's identity is the exported variable itself. Linking = `import`.
  A broken link is therefore a compile error; no separate check is needed.
- The `self.*` id namespace is reserved for facts about the memory's owner (used by the profile view).
- **Locations are canonical addresses.** A field that says where something lives (`asset.location`, `claim.where`) has the
  type `Location`, which is either `url("https://…")` — the real, machine-independent address (repository, tracker, cloud
  folder, site, service) — or `local(path, { confirmedBy: "owner", at })` for something the owner confirmed exists on one
  machine only. A plain string does not compile, so a location can never silently be a local path (K15).
  `url()` rejects anything that is not an absolute http(s) URL.

## 4. Types

**Common fields (required on every definition):**
- `id` — dot-separated name (e.g. `site.analytics`)
- `title` — short human description (any language)
- `origin` — birth certificate: the `session` it was written in. Answers "why does this exist?".
- `verify` — verification (§5). Not on past-tense types.
- `evidence` — evidence level (§6). Not on past-tense types.

**Present-tense types:**

| Type | What | Own required fields | Red when… |
|---|---|---|---|
| `fact` | Something about the world | `value`, `key` | verification fails or expires; unused (K12) |
| `claim` | Something we say publicly (site, profile, post) | `text`, `where` (a `Location`), `restsOn` | the text is not there; a dependency is red; a fact dependency's evidence is too weak (K4) |
| `decision` | A decision | `restsOn`, `review` (re-approval interval); optional `supersedes` | a dependency is red; re-approval expired |
| `promise` | A commitment | `owner`, `due` (a date **or** a condition), `doneWhen`, `requires` | a precondition is red (at once); or the due date passed / due condition became true and `doneWhen` is not met |
| `goal` | A planned piece of work | `phase`, `doneWhen`, `requires` | a precondition is red (at once); or the phase ended and `doneWhen` is not met |
| `idea` | An option deliberately parked | `text`, `reason` (why it waits), `revisitWhen`; optional `basedOn` (what it came from — counts as use, never propagates) | never red; **yellow** when `revisitWhen` comes true |
| `account` | An account on a service | `service`, `owner`, `login` (never a password), `agentAccess` | access verification fails; no asset uses it (K12) |
| `asset` | Something we set up (site, repo, setting, profile, backup) | `on` (an `account`), `desired`, `location` (a `Location`, §3) | the world does not match `desired` (drift, K7) |
| `rule` | A working rule for the agent | `text`, `appliesTo`; optional `restsOn` (why the rule exists) | verification fails; a dependency is red |

**Vocabulary type:**

| Type | What | Required fields | Rule |
|---|---|---|---|
| `key` | A property of a subject that facts state a value of, e.g. `key:ada.budgetCap` (its own id namespace, so it never collides with a definition id) | `subject` (lowerCamelCase), `name` (lowerCamelCase), `valueType` (`amount`, `date`, `text`, `list`, `boolean`, `number`, `url`), `describe` (a few plain words); optional `distinctFrom` (keys it was compared with and is not) | One property only (K24). A new key near an existing one must say it is distinct (K23). No `verify`: a key states nothing about the world. |

Every `fact` names its `key` (required). One present-tense fact per key (K22): a new value of the same property changes that fact,
it does not add a second one.

**Past-tense types:**

| Type | What | Required fields | Rule |
|---|---|---|---|
| `session` | A working session | `at`, `topic`, `questions` | The session note and log line are generated from it and from the definitions born in it |
| `event` | Something that happened | `at`, `text`; optional `affects`, `retires` (ids of present-tense definitions removed that day, K20) | Immutable once its day has passed |
| `research` | A piece of research | `at`, `question`, `findings`, `readWhen`; optional `rawData` | Its readable page is generated from the findings. Immutable once its day has passed |

**Finding:** one result of a research. `text`, optional `value`, optional `source` (URL or a place in `rawData`).
If a finding is relied on today, a `fact` is written with `verify: fromFinding(finding, { ttl })`.
If not, it is parked explicitly with `parked: { reason, revisitWhen }` (K12).

## 5. Verifications (`verify`)

| Kind | What it does | Example | Run by |
|---|---|---|---|
| `probe` | Looks at the world automatically | `page(url).contains(text)`, `http(url).status(200)`, `header(url, name).contains(x)`, `file(local(path)).exists()`, `git(repo).clean()`, `cmd(...)` | the CLI, in seconds |
| `agentProbe` | A look that needs a logged-in browser | `agentProbe("dashboard shows the account", "30d", last)` | the agent; result + date are recorded and expire with `ttl` |
| `source` | Read in a primary source | `source(url, { readAt, ttl: "30d" })` | the agent; red when expired |
| `fromFinding` | Relies on a research finding | `fromFinding(finding, { ttl: "90d" })` | the compiler; red when expired |
| `review` | Periodic human approval | `review({ by: "owner", at, every: "60d" })` | the owner; red when expired |
| `confirm` | One-off human confirmation that something was done | `confirm({ by: "owner", what: "first sale" })` → not satisfied; with `at` → satisfied. `what` names what is awaited | the owner |
| `derived` | Derived from other definitions | `derived([a, b])` | the compiler; red if an input is red |
| `after` | A date has been reached | `after("2026-12-01")` → satisfied from that day on | the compiler |

Every present-tense definition has exactly one `verify`. This is enforced at the type level.

**Conditions.** `revisitWhen` (ideas, parked items) and a condition-type `promise.due` must be a *condition*:
`probe`, `confirm`, `after` or `derived`. A condition "comes true" when it is satisfied.
(Freshness verifications — `source`, `fromFinding`, `review`, `agentProbe` — are not conditions.)

## 6. Evidence levels (`evidence`)

Strongest to weakest: `live` (tried in the world) · `source` (read in a primary source) · `human` (approved by the owner) ·
`research` (our own research finding) · `codeRead` (only the code was read) · `secondHand` (heard from someone else or an AI).

## 7. Compile rules

- **K1 — Coverage:** a definition without a test does not compile. Coverage is always 100%, or there is no build. (Type level.)
- **K2 — Links:** links are imports. A broken link is a compile error. (Type level.)
- **K3 — Propagation:** if a definition is red, everything linked to it through `restsOn` / `requires` / `derived` / `on` / `fromFinding` is red too (an idea's `basedOn` and conditions do not propagate). The reason is shown as a chain.
- **K4 — Public claims:** a `claim` may rest on a `fact` only if that fact's evidence is `live` or `source`. Decisions, rules and other present-tense definitions (our own choices) may be claim dependencies. (Type level + compiler.)
- **K5 — The past is immutable:** changing or deleting a `session`, `event` or `research` after its day is a compile error. Same-day corrections are allowed. (Checked against git history.)
- **K6 — Views are generated, never hand-written:** `NOW.md`, `decisions.md`, `promises.md`, `ideas.md`, `roadmap.md`, `profile.md`, `AGENTS.md`, `sessions/*.md`, `log.md`, `library/*.md`, `library/INDEX.md`. A hand edit (body hash mismatch), a stale view, or a hand-written `.md` in `sessions/` or `library/` is a compile error.
- **K7 — Drift:** for an `asset`, `desired` is compared with the world. Any difference is red, whoever made it.
- **K8 — Expiry:** an expired verification is red. The last 20% of its window is yellow.
- **K9 — Language growth:** a new type may only be added together with its verification and its tests.
- **K10 — (removed in v0.1):** whether a text is a secret cannot be decided structurally (principle 3). Not writing secrets is an agent rule; a memory is never pushed anywhere.
- **K11 — Definition first, then the world:** to change the world, change the definition first (it turns red), then change the world (it turns green).
- **K12 — No unused knowledge:** every `fact`, finding and `rawData` file must support a `decision`, `claim`, `goal`, `promise`, `rule`, `asset` or `idea` (directly or through a chain), or be parked with a reason. Otherwise red. Facts about the owner (`self.*`) are used by the profile view and need no other use. A parked item's `revisitWhen` is a verification; when it comes true the item turns yellow.
- **K13 — Birth certificate:** a definition without `origin` does not compile. `origin` links to an existing `session`. (Type level.)
- **K14 — Preconditions:** `goal` and `promise` require `requires` (explicitly `[]` when there are none). Preconditions must be green **today**; if one is red, the goal/promise is red at once, regardless of its deadline. (Type level + compiler.)
- **K15 — Portability:** locations are typed (`url()` or owner-confirmed `local()`, §3; type level). A memory loads nothing from outside its own folder (its pinned `alfredish` copy included): the TypeScript program built from the memory's `tsconfig.json` is inspected, and any source file outside the folder (other than installed type libraries) is red.
- **K16 — Type rules also hold at run time:** every promise the type level makes is checked again on the loaded
  definitions, because type checks can be switched off: a known `kind`; a string `id`; `origin` is a session (K13);
  a present-tense definition has a `verify` of a known kind and an `evidence` level (K1); `goal` / `promise` have
  `requires` (K14); a `location` / `where` is `url()` or `local()` (K15); every link points to a definition (K2). A
  violation is red, names the rule and says the fix (e.g. "rule.x has no verify: give it a test (§5)"); the check never
  crashes on a malformed definition.
- **K17 — No type escapes in a memory:** a memory's source files contain no `as any`, `as unknown`, `<any>`, `any`
  annotations, `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck`. Checked with TypeScript's own parser: escapes are
  syntax-tree nodes and the comments the parser attaches to tokens, so text inside strings, templates, regular
  expressions or ordinary comments is never reported. Red with file and line.
- **K18 — Everything in the memory folder is checked:** every definition exported from any `.ts` file under the memory
  folder must be reachable from the entry (`memory/index.ts`). One that is not is red: "defined in X but not reachable
  from the index: export it from the index". Files that export no definitions (helpers) are fine.
- **K19 — Evidence cannot claim more than the test proves:** the `evidence` level may not be stronger than its
  verification can give: `probe`, `agentProbe` → `live`; `source` → `source`; `review`, `confirm`, `after` → `human`;
  `fromFinding` → `research`; `derived` → the weakest evidence among its inputs. Red otherwise, so K4 cannot be passed
  with a label.
- **K20 — Nothing disappears silently:** a present-tense definition that is in the last commit and is gone now is red,
  unless an `event` dated today lists its id in `retires` (its `text` says why). Compared with `HEAD`; once owner
  approval exists, with the last signed record.
- **K21 — No back-dating:** a definition that is not in the last commit must be born in a session that is not in the last
  commit either (the session being written now) or in a session dated today. Red otherwise: "born in s.X, which is
  already committed: use the current session". Compared with `HEAD`; once owner approval exists, with the last signed
  record.
- **K22 — One value per property:** two present-tense facts with the same `key` are red: "two values for ada.budgetCap:
  f1, f2 — change the existing fact, or retire one (K20)". This is how a duplicate or a contradiction becomes visible
  without reading any text.
- **K23 — A new key must be compared with the existing ones:** for a key that is not in the last commit, the keys of
  the same subject are ranked by meaning similarity (§9.1). Every one at or above **0.70** must be decided: listed in the
  new key's `distinctFrom`, or listing the new key in its own (a pair is decided once, from either side). Otherwise red,
  showing the candidates with their scores: "new key ada.monthlyLimit is close to
  ada.budgetCap (0.86): use it, or add it to distinctFrom". So the agent cannot open a key without having seen the
  existing ones, and its decision is recorded and shown to the owner. 0.70 is measured with a margin: on 20 renamed
  updates the true existing key always ranked first and scored at least 0.764; a lower threshold only means more
  `distinctFrom` decisions, a missed duplicate costs more.
- **K24 — A key is one property:** a key `name` whose last word — the head of an English compound — is a catch-all word
  (`summary`, `info`, `details`, `general`, `overview`, `misc`, `other`, `data`, `notes`) is red: "split it into one key
  per property". `employerSummary` is red; `dataExposureRate` (a rate) is not.
- **K25 — A test says everything it does:** a memory builds probes only with Alfredish's probe builders (`page`, `http`,
  `header`, `file`, `git`, `cmd`); a direct `probe(…, fn)` in a memory file is red (checked on syntax trees, like K17).
  Every builder's description contains all its arguments (`cmd`: `<label> — runs: <command> <args> [expect /re/]`), so a
  definition's hash (K5, §14) covers what its test really does.
- **K26 — Owner approval** (§14): a definition whose content differs from what the owner last signed is **unapproved**.
  Unapproved is shown as yellow with the reason, never as green, and never stops a commit. Something resting on an
  unapproved definition is unapproved too (K3). A `review`, a `confirm` or a `local()` that the owner has not signed
  counts as not given at all: a renewal the agent wrote itself cannot lift red.
- **K27 — Approval records are checked:** every record's signature is valid for a key on the owner's anchor list, and the
  records form an unbroken chain. A bad signature, an unknown key or a broken chain is red.
- **K28 — The signed state is the reference:** K5, K20, K21 and K23 compare with the last signed record, not `HEAD`
  (`HEAD` only until a first record exists), so a commit made past the hook cannot move the reference. The hash of the
  memory's `vendor/alfredish` copy is part of every record: a changed copy is red until the owner approves it.

## 8. Statuses

`green` (passed) · `yellow` (expiring soon / a parked item's or idea's revisit condition came true) · `red` (failed) · `unknown` (could not look, e.g. offline or another machine).
`unknown` is never treated as `green`. Commit rule: no commit while anything is `red`.

## 9. CLI

| Command | What it does | Output |
|---|---|---|
| `alfred check` | Compiles and runs all tests and repository checks | One line when all green: `✓ 41 definitions · 41 tests · 100% · 0 parked`. Otherwise only the red/yellow lines with reasons. |
| `alfred check <area>` | The same check on the whole memory; only the area's probes (and those of everything it rests on) are forced to run live | As `alfred check` |
| `alfred check --quick` | The same check on the whole memory; no probe is forced to run live | As `alfred check` |
| `alfred get <id>` | Value, status and origin of one definition | Value + status + last verification + origin; a "do not use" warning when red |
| `alfred why <id>` | Why it exists and what depends on it (up and down the chain) | Tree |
| `alfred diff <a>[..<b>]` | **Meaning-level** difference between two dates or commits | Definition by definition, not line by line |
| `alfred build` | Generates every view (K6) | Changed files |
| `alfred hook` | Installs a pre-commit hook in the memory repository: `alfred check` before every commit | Hook path |
| `alfred keys <subject> [--like "<text>"]` | The subject's keys; with `--like`, the three most similar with their scores (to look before opening a new key) | One line per key |

**Live probes.** Every probe a run needs starts at once (at most 16 at a time), and each probe runs at most once per run.
The result of every probe that ran live is cached in `.alfredish-cache.json` at the repository root, keyed by the probe's
description; the cache is not memory and is not committed (it belongs in `.gitignore`).

The graph checks — K1-K24, propagation (K3), expiry (K8) — always cover the whole memory. The *scope* only decides which
probes are forced to run live:

- `alfred check`: every probe. The pre-commit hook runs this, so nothing is committed on cached results.
- `alfred check <area>`: an area is a folder under the memory folder (`projects/golive`, `self`; its last segment is enough
  when unique). The probes of the definitions exported from the area's files, and of everything they rest on (their whole
  dependency chain), are forced.
- `alfred check --quick`, `get`, `why`, `build`: none.

A probe outside the scope still runs live unless the cache holds a result of a real look (`green` or `red`, not `unknown`)
younger than 24 hours; that result is used as it is, red included, so it still propagates (K3). So a new, changed, unlooked
or stale probe is always looked at, and a red result inside the scope still propagates to dependents in other areas. To see
a fix outside the scope turn green, check its area or run the full check.

### 9.1 Meaning similarity

Used only by K23 and `alfred keys`. A fixed embedding model ships inside alfredish (`models/`, its sha256 pinned):
nomic-embed-text-v1.5 (Q4_K_M, Apache-2.0), run in-process with llama.cpp (node-llama-cpp); no network, no external
application. The text compared is `clustering: <name> — <describe>`; similarity is the cosine of the two vectors. If
the model is missing, altered (hash mismatch) or cannot run, K23 is red ("cannot compare keys") — it never passes
unseen.
## 10. Agent rules (for every agent using Alfredish)

1. At session start run `alfred check`, then read only `NOW.md`. During the session use `alfred check --quick` or
   `alfred check <area>`; the full check runs again before the commit (hook).
2. Open a `session` definition (topic + questions). Every definition written in this session has it as `origin`.
3. Before stating a present-tense fact to the owner or publicly, take it from its source with `alfred get` and name the definition.
4. Change the world in K11 order.
5. Never hand-write notes. At session end: `alfred build` + `alfred check`; if green, one commit.
6. Exchanges with other agents (sub-agents, other models) use Alfredish definitions; results enter memory only through the compiler.

## 11. Examples

### Setting something up (changing the world)

```ts
export const host = account({
  id: "hosting.main", title: "Hosting account", origin: s1,
  service: "example-host", owner: "owner", login: "owner@example.com", agentAccess: "browserSession",
  verify: agentProbe("dashboard shows owner@example.com", "30d", { ok: true, at: "2026-01-10" }),
  evidence: "live",
});

export const analytics = asset({
  id: "site.analytics", title: "Visitor analytics on the site", origin: s1, on: host,
  desired: "cookieless-analytics", location: "https://example.com/",
  verify: page("https://example.com/").hasScriptFrom("analytics.example.net"),
  evidence: "live",
});
```

### Research → finding → fact → decision → public claim

```ts
export const scan = research({
  id: "research.market.scan", title: "Job board scan", origin: s1,
  at: "2026-01-10", question: "What do customers pay?", readWhen: "when pricing is discussed",
  rawData: ["library/raw/2026-01-10-scan.csv"],
  findings: {
    median: finding({ text: "Median fixed budget", value: "500 USD", source: raw("library/raw/2026-01-10-scan.csv", "budget") }),
    regional: finding({ text: "Regional regulation dates", parked: { reason: "not our market", revisitWhen: after("2026-07-01") } }),
  },
});

export const medianBudget = fact({
  id: "market.medianBudget", title: "Median fixed budget", origin: s1,
  value: "500 USD", verify: fromFinding(scan.findings.median, { ttl: "90d" }), evidence: "research",
});

export const price = decision({
  id: "offer.price", title: "Basic check costs $290", origin: s2,
  restsOn: [medianBudget], review: "60d",
  verify: review({ by: "owner", at: "2026-01-11", every: "60d" }), evidence: "human",
});

export const priceOnSite = claim({
  id: "site.price", title: "Price shown on the site", origin: s2,
  text: "$290", where: "https://example.com/", restsOn: [price],   // K4: a decision may back a claim
  verify: page("https://example.com/").contains("$290"), evidence: "live",
});
```

### A promise with a condition as deadline

```ts
export const askAccountant = promise({
  id: "tax.askAccountant", title: "Ask the accountant 3 questions", origin: s2, owner: "owner",
  due: firstSale,                       // a verification: once the first sale happens and this is not done → red
  requires: [], doneWhen: confirm({ by: "owner" }), evidence: "human",
});
```

## 12. v0.1 scope

- In: §4 types, §5 verifications, §7 rules, §9 commands, the pre-commit hook, generating the K6 views.
- Out (later versions): reading service APIs directly, a visual UI, multiple owners.

## 13. Decisions taken while writing v0.1

1. Generated views: see K6.
2. Existing free-prose decision logs: still-valid decisions become `decision`s; the rest become `event`s. The file is then generated.
3. Present-tense documents (current offer, profile, roadmap): their content becomes definitions (`fact`, `goal`, `self.*` facts + `review`); the files are generated.
4. Existing research documents: each becomes a `research`; every finding is either linked or parked. Unlinkable findings go to the owner as one list ("park or delete?").
5. Existing session notes and logs: migrated once as `session` + `event`; generated afterwards.
6. A memory is self-contained and portable (principle 4, K15).

## 14. Owner approval

**Why.** Some truths only the owner knows (a budget, a decision, a rule, that a test checks the right thing). An agent
can write anything; nothing it writes looks approved until the owner signs exactly that content (K26).

**The anchor.** A list of the owner's SSH public keys in a file only an administrator can write, outside the memory
(`/etc/alfredish/owner.pub` on macOS and Linux; overridable). Where the private key lives is the owner's choice
(e.g. a Secure Enclave key that asks for Touch ID on every signature); Alfredish only verifies.

**A record.** `approvals/NNNN.json` in the memory: `{ n, at, base: <hash of the previous record>, alfredish: <hash of
vendor/alfredish>, approved: { id: hash }, removed: [id], rejected: { id: note }, corrections: { id: note } }`, with a
detached SSH signature (`ssh-keygen -Y sign`, namespace `alfredish`) in `approvals/NNNN.json.sig`. Verifying needs only
the public keys and `ssh-keygen`.

**Reasons.** Every definition that differs from the last record carries a one-line reason in the session it was
changed in (`session({ …, changes: { "<id>": "<why>" } })`); a change without a reason is red.

**`alfred approve`** — run by the owner, in their own terminal; installed outside the memory, writable only by an
administrator, so editing the memory's copy of Alfredish does not change it. It lists every difference since the last
record with its reason, in two groups: **your calls** first (decisions, rules, promises, goals, ideas, keys and their
`distinctFrom` decisions, anything verified by `review` / `confirm` / `cmd`, every `local()`, every removal), then
**machine-checked** lines (facts, assets, accounts and claims verified by a built-in probe other than `cmd`, each shown
with its test). Per item: **approve**, **correct** (a note; the agent's next version comes back, shown as the
difference from its first try), **reject** (it must return to its approved content; red until it does), or **skip**
(stays unapproved). One signature signs the round. It signs only with a key on the anchor list; with none on this
machine, nothing is recorded.

**The owner's habit.** Any program can ask the key to sign. The owner signs only while running `alfred approve`
themselves; a prompt naming another program (e.g. the agent's) is refused.
