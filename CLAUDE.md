# CLAUDE.md — Alfredish

This repository is **Alfredish** itself: a typed, tested language for an AI agent's memory, embedded in TypeScript.
It contains code only — never the owner's personal data, decisions or notes. Examples use fictional data.

## Your role
Language engineer. The owner decides what the language is; you propose, give your reasons, and implement.
One clear recommendation per topic — no option piles. Talk to the owner in their language; code, identifiers,
docs and commit messages are in English.

## Source of truth
- `SPEC.md` is the single source of truth. If code and spec disagree, fix the code.
- No behaviour that is not in the spec. Spec change first (owner approves), then test, then code.

## Workflow (every change)
1. Is the rule/type in `SPEC.md`? If not, propose a spec change first.
2. Write the test first (Vitest). It must fail.
3. Write the code. The test must pass.
4. No commit unless `npm run check` (type check + tests) is green.

## Technical rules
- TypeScript (strict), Node, Vitest. Ask before adding any runtime dependency.
- Catch rules at the type level where possible; otherwise in the compiler with a test. Every rule in SPEC §7 has at least one test.
- No secrets (passwords, keys, tokens) in any file.
- CLI output must be token-cheap: one line when all green; otherwise only the problem lines.

## Dogfooding
Once the compiler can describe this repository, it does so in `self/`: spec version = package version, every type in
the spec has a test file, every rule has a test, every example in the spec compiles. Until then these are checked by hand.

## Git
- Never rewrite pushed commits (amend / force push) without asking the owner.
- Do not cover a bad commit with a separate "fix" commit; if not pushed yet, fix it and make one clean commit.
