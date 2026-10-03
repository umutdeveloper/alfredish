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
3. **A memory is one portable folder.** It works on any machine with Node: it carries a pinned copy of `alfredish`
   and refers to things by where they really live (§3), not by paths on one machine.
4. Knowledge is in one of two tenses:

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
- **Locations are canonical addresses.** Anything that lives somewhere is referred to by its real, machine-independent
  address: the URL of its repository (GitHub, GitLab…), issue tracker (Jira…), cloud folder, site or service.
  **Any local path is red** (K15), and the agent must ask the owner: "what should be written instead of this path?"
  The only exception is something the owner has explicitly confirmed exists on one machine only:
  `local(path, { confirmedBy: "owner", at })`. Such verifications are `unknown` (never green) on any other machine.

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
| `fact` | Something about the world | `value` | verification fails or expires; unused (K12) |
| `claim` | Something we say publicly (site, profile, post) | `text`, `where`, `restsOn` | the text is not there; a dependency is red; a fact dependency's evidence is too weak (K4) |
| `decision` | A decision | `restsOn`, `review` (re-approval interval); optional `supersedes` | a dependency is red; re-approval expired |
| `promise` | A commitment | `owner`, `due` (a date **or** a condition), `doneWhen`, `requires` | a precondition is red (at once); or the due date passed / due condition became true and `doneWhen` is not met |
| `goal` | A planned piece of work | `phase`, `doneWhen`, `requires` | a precondition is red (at once); or the phase ended and `doneWhen` is not met |
| `idea` | An option deliberately parked | `text`, `reason` (why it waits), `revisitWhen`; optional `basedOn` (what it came from — counts as use, never propagates) | never red; **yellow** when `revisitWhen` comes true |
| `account` | An account on a service | `service`, `owner`, `login` (never a password), `agentAccess` | access verification fails; no asset uses it (K12) |
| `asset` | Something we set up (site, repo, setting, profile, backup) | `on` (an `account`), `desired`, `location` (canonical address, §3) | the world does not match `desired` (drift, K7) |
| `rule` | A working rule for the agent | `text`, `appliesTo`; optional `restsOn` (why the rule exists) | verification fails; a dependency is red |

**Past-tense types:**

| Type | What | Required fields | Rule |
|---|---|---|---|
| `session` | A working session | `at`, `topic`, `questions` | The session note and log line are generated from it and from the definitions born in it |
| `event` | Something that happened | `at`, `text`; optional `affects` | Immutable once its day has passed |
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
- **K10 — No secrets:** passwords, keys and tokens never appear in definitions. The compiler scans for known key formats and stops.
- **K11 — Definition first, then the world:** to change the world, change the definition first (it turns red), then change the world (it turns green).
- **K12 — No unused knowledge:** every `fact`, finding and `rawData` file must support a `decision`, `claim`, `goal`, `promise`, `rule`, `asset` or `idea` (directly or through a chain), or be parked with a reason. Otherwise red. Facts about the owner (`self.*`) are used by the profile view and need no other use. A parked item's `revisitWhen` is a verification; when it comes true the item turns yellow.
- **K13 — Birth certificate:** a definition without `origin` does not compile. `origin` links to an existing `session`. (Type level.)
- **K14 — Preconditions:** `goal` and `promise` require `requires` (explicitly `[]` when there are none). Preconditions must be green **today**; if one is red, the goal/promise is red at once, regardless of its deadline. (Type level + compiler.)
- **K15 — Portability:** a memory imports nothing outside its own folder (its pinned `alfredish` copy included), and refers to locations by canonical address (§3). Any local path (e.g. `/Users/…`, `~/…`, `C:\…`) anywhere in a definition is red unless wrapped in an owner-confirmed `local(...)`; the red message asks the owner for the canonical address. An import from outside the folder is a compile error.

## 8. Statuses

`green` (passed) · `yellow` (expiring soon / a parked item's or idea's revisit condition came true) · `red` (failed) · `unknown` (could not look, e.g. offline or another machine).
`unknown` is never treated as `green`. Commit rule: no commit while anything is `red`.

## 9. CLI

| Command | What it does | Output |
|---|---|---|
| `alfred check` | Compiles and runs all tests and repository checks | One line when all green: `✓ 41 definitions · 41 tests · 100% · 0 parked`. Otherwise only the red/yellow lines with reasons. |
| `alfred get <id>` | Value, status and origin of one definition | Value + status + last verification + origin; a "do not use" warning when red |
| `alfred why <id>` | Why it exists and what depends on it (up and down the chain) | Tree |
| `alfred diff <a>[..<b>]` | **Meaning-level** difference between two dates or commits | Definition by definition, not line by line |
| `alfred build` | Generates every view (K6) | Changed files |
| `alfred hook` | Installs a pre-commit hook in the memory repository: `alfred check` before every commit | Hook path |

`probe` results may be cached briefly (default 10 minutes). The pre-commit hook bypasses the cache.

## 10. Agent rules (for every agent using Alfredish)

1. At session start run `alfred check`, then read only `NOW.md`.
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
6. A memory is self-contained and portable (principle 3, K15).
