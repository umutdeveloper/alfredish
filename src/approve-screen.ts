// SPEC §14: the owner's approval screen in a terminal — one change at a time, the reason first, buttons chosen with the
// arrow keys, a summary before the one signature. The screen is a pure state machine (keys in, text out), so it is
// tested without a terminal; approve.ts wires it to one. What it shows comes from the same changes the record is built
// from, so the owner sees exactly what they sign.
import type { Change, Decision } from "./approve.ts";

export type Button = "approve" | "correct" | "reject" | "skip" | "approveRemoval" | "startAll" | "startOne" | "approveGroup" | "sign" | "back" | "quit";

const W = {
    approve: "approve", correct: "correct", reject: "reject", skip: "skip", approveRemoval: "approve removal",
    startAll: "approve all as the starting point", startOne: "look one by one", approveGroup: "approve all of them", sign: "sign", back: "back", quit: "quit without signing",
    why: "why", test: "test", noteLast: "your note last time", noteCorrect: "note for the agent — what should change:", noteReject: "why (optional):",
    noteEmpty: "write the note first", keys: "← → choose · enter apply · ↑ ↓ previous / next · q quit", keysNote: "type · enter save · esc cancel",
    summary: "summary", nothing: "Nothing decided: nothing will be recorded.", signHint: "Signing asks for your fingerprint once. Give it only if the prompt names your terminal.",
    start: (n: number) => `First approval: ${n} definitions make up the memory today.`, startWhy: "Approve the memory as it is as your starting point, or look at each definition.",
    moved: (n: number, m: string) => `${n} definitions moved to ${m}`, movedWhy: (m: string) => `each is in ${m}'s owner-signed state, where you approved it; approve their removal here together, or look one by one`,
    newKeys: (n: number) => `${n} new keys`, newKeysWhy: "each is the question a definition answers, listed with the keys it was compared with and is not (distinctFrom); approve them together, or look one by one",
    machine: (n: number) => `${n} machine-checked changes`, machineWhy: "each is checked by a built-in test that looks at the world (shown below); approve them together, or look one by one",
    dropped: "dropped as a repeat", kept: "kept", droppedWhy: "it only retells the kept event below (K32): approve to remove it from the memory; it stays in the signed records and in git",
    vendor: "the copy of Alfredish", noReason: "(no reason given)", sessionWhy: "the session record: its topic, questions and the reasons above",
    ops: { "+": "new", "~": "changed", "-": "removed" }, approved: "approved", corrected: "correction", rejected: "rejected", skipped: "skipped",
} as const;

/** One screen: a change, the Alfredish copy, or the first-round question. `key` is what the decision is stored under. */
export interface Entry {
  key: string;
  title: string;
  sub: string;
  why: string;
  lines: string[];
  buttons: Button[];
  /** A question, not a decision of its own (the first round, a group): not in the summary or the dots. */
  start?: boolean;
  /** For a group: the keys it decides together. */
  members?: string[];
}

export const VENDOR_KEY = "vendor/alfredish";

/** A past event dropped as a repeat (K32), as alfred approve shows it: the event it retold, their score, the kept text. */
export interface ShownDrop {
  repeatOf: string;
  score: number;
  kept: Record<string, unknown>;
}

export function entriesFor(changes: readonly Change[], o: { vendor?: string[]; firstRound: boolean; moved?: ReadonlyMap<string, string>; dropped?: ReadonlyMap<string, ShownDrop> }): Entry[] {
  const w = W;
  const out: Entry[] = [];
  if (o.firstRound) out.push({ key: "__start", title: w.start(changes.length), sub: "", why: w.startWhy, lines: [], buttons: ["startAll", "startOne"], start: true });
  if (o.vendor) out.push({ key: VENDOR_KEY, title: w.vendor, sub: "", why: "", lines: o.vendor, buttons: ["approve", "skip"] });
  const machine = changes.filter((c) => c.group === "machine");
  // New keys, offered together (K22, K23): each with its question and its distinctFrom decisions.
  const keys = changes.filter((c) => c.op === "+" && c.kind === "key");
  if (keys.length > 1) out.push({ key: "__keys", title: w.newKeys(keys.length), sub: "", why: w.newKeysWhy, lines: keys.flatMap((c) => [`+ ${c.id}`, ...c.shown.map((l) => `    ${l}`)]), buttons: ["approveGroup", "startOne"], start: true, members: keys.map((c) => c.id) });
  // Removals of definitions that moved into another memory, offered together (one step per destination).
  const moved = changes.filter((c) => c.op === "-" && o.moved?.has(c.id));
  for (const dest of [...new Set(moved.map((c) => o.moved!.get(c.id)!))]) {
    const these = moved.filter((c) => o.moved!.get(c.id) === dest);
    if (these.length < 2) continue;
    out.push({ key: `__moved:${dest}`, title: w.moved(these.length, dest), sub: "", why: w.movedWhy(dest), lines: these.map((c) => `- ${c.id}  (${c.kind})`), buttons: ["approveGroup", "startOne"], start: true, members: these.map((c) => c.id) });
  }
  for (const c of changes) {
    if (machine.length > 1 && c === machine[0]) {
      const lines = machine.flatMap((m) => [`${m.op} ${m.id}${m.why ? ` — ${m.why}` : ""}`, `    test: ${m.test ?? "?"}`]);
      out.push({ key: "__machine", title: w.machine(machine.length), sub: "", why: w.machineWhy, lines, buttons: ["approveGroup", "startOne"], start: true, members: machine.map((m) => m.id) });
    }
    const lines = [...(c.note ? [`${w.noteLast}: ${c.note}`, ""] : []), ...c.shown, ...(c.test ? [`${w.test}: ${c.test}`] : [])];
    const why = c.why ?? (c.kind === "session" ? w.sessionWhy : w.noReason);
    const drop = c.op === "-" ? o.dropped?.get(c.id) : undefined;
    if (drop) {
      // K32: both accounts in full, side by side in reading order; skip first, so pressing on never removes the past.
      const kept = [`${w.kept}: ${drop.repeatOf} (${drop.score.toFixed(2)})`, `  ${String(drop.kept["title"] ?? "")}`, `  ${String(drop.kept["text"] ?? "")}`];
      out.push({ key: c.id, title: c.id, sub: `${c.kind} · ${w.dropped}`, why: w.droppedWhy, lines: [...lines, "", ...kept], buttons: ["skip", "approveRemoval"] });
      continue;
    }
    out.push({ key: c.id, title: c.id, sub: `${c.kind} · ${w.ops[c.op]}`, why, lines, buttons: c.op === "-" ? ["approveRemoval", "skip"] : ["approve", "correct", "reject", "skip"] });
  }
  return out;
}

export interface Screen {
  entries: Entry[];
  cur: number;
  sel: number;
  mode: "browse" | "note" | "summary" | "signed" | "quit";
  note: string;
  noteFor?: "correct" | "reject";
  error?: string;
  decisions: Map<string, Decision>;
  /** Keys a group step decided: moving on skips them, and nothing else (every other entry is still shown). */
  grouped: Set<string>;
}

export const newScreen = (entries: Entry[]): Screen => ({ entries, cur: 0, sel: 0, mode: "browse", note: "", decisions: new Map(), grouped: new Set() });

/** A key as Node's readline reports it. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

const SUMMARY_BUTTONS: Button[] = ["sign", "back", "quit"];

const anyDecided = (s: Screen) => [...s.decisions.values()].some((d) => d.kind !== "skip");

function buttonsOf(s: Screen): Button[] {
  if (s.mode === "summary") return anyDecided(s) ? SUMMARY_BUTTONS : ["back", "quit"];
  return s.entries[s.cur]!.buttons;
}

function advance(s: Screen): void {
  s.sel = 0;
  let next = s.cur + 1;
  while (next < s.entries.length && s.grouped.has(s.entries[next]!.key)) next++;
  if (next < s.entries.length) s.cur = next;
  else s.mode = "summary";
}

function decide(s: Screen, d: Decision): void {
  s.decisions.set(s.entries[s.cur]!.key, d);
  advance(s);
}

function press(s: Screen, b: Button): void {
  switch (b) {
    case "approve":
    case "approveRemoval":
      return decide(s, { kind: "approve" });
    case "skip":
      return decide(s, { kind: "skip" });
    case "correct":
    case "reject":
      s.mode = "note";
      s.noteFor = b;
      s.note = "";
      delete s.error;
      return;
    case "startAll":
      for (const e of s.entries) if (!e.start) s.decisions.set(e.key, { kind: "approve" });
      s.mode = "summary";
      s.sel = 0;
      return;
    case "startOne":
      return advance(s);
    case "approveGroup": {
      for (const k of s.entries[s.cur]!.members ?? []) {
        s.decisions.set(k, { kind: "approve" });
        s.grouped.add(k);
      }
      return advance(s); // to the next entry that is not one of them — entries between them are still shown
    }
    case "sign":
      s.mode = "signed";
      return;
    case "back":
      s.mode = "browse";
      s.sel = 0;
      return;
    case "quit":
      s.mode = "quit";
      return;
  }
}

/** One key press. Returns the same screen, changed. */
export function step(s: Screen, k: Key): Screen {
  if (k.ctrl && k.name === "c") {
    s.mode = "quit";
    return s;
  }
  if (s.mode === "note") {
    if (k.name === "escape") s.mode = "browse";
    else if (k.name === "return" || k.name === "enter") {
      const note = s.note.trim();
      if (s.noteFor === "correct" && !note) s.error = "empty";
      else {
        s.mode = "browse";
        decide(s, s.noteFor === "correct" ? { kind: "correct", note } : note ? { kind: "reject", note } : { kind: "reject" });
      }
    } else if (k.name === "backspace") s.note = [...s.note].slice(0, -1).join("");
    else if (k.sequence && !k.ctrl && !k.meta && [...k.sequence].every((ch) => ch >= " ")) {
      s.note += k.sequence;
      delete s.error;
    }
    return s;
  }
  if (s.mode !== "browse" && s.mode !== "summary") return s;
  const n = buttonsOf(s).length;
  switch (k.name) {
    case "right":
    case "tab":
      s.sel = (s.sel + 1) % n;
      break;
    case "left":
      s.sel = (s.sel + n - 1) % n;
      break;
    case "down":
      if (s.mode === "browse") advance(s);
      break;
    case "up":
      if (s.mode === "summary") s.mode = "browse";
      else if (s.cur > 0) s.cur--;
      s.sel = 0;
      break;
    case "return":
    case "enter":
      press(s, buttonsOf(s)[s.sel]!);
      break;
    case "q":
      s.mode = "quit";
      break;
  }
  return s;
}

const B = (x: string) => `\x1b[1m${x}\x1b[0m`;
const DIM = (x: string) => `\x1b[2m${x}\x1b[0m`;
const INV = (x: string) => `\x1b[7m ${x} \x1b[0m`;
const COLOUR: Record<Decision["kind"], string> = { approve: "\x1b[32m", correct: "\x1b[33m", reject: "\x1b[31m", skip: "\x1b[2m" };

function dots(s: Screen): string {
  return s.entries
    .map((e, i) => {
      if (e.start) return "";
      const d = s.decisions.get(e.key);
      const dot = d ? `${COLOUR[d.kind]}●\x1b[0m` : "○";
      return i === s.cur && s.mode !== "summary" ? `[${dot}]` : dot;
    })
    .filter(Boolean)
    .join(" ");
}

/** The whole screen as text (with terminal colours). */
export function render(s: Screen): string {
  const w = W;
  const real = s.entries.filter((e) => !e.start);
  const out: string[] = [];
  const buttons = (bs: Button[]) => bs.map((b, i) => (i === s.sel ? INV(w[b]) : `[ ${w[b]} ]`)).join("  ");
  if (s.mode === "summary") {
    out.push(`${B("alfred-approve")} · ${w.summary}   ${dots(s)}`, "");
    const decided = real.filter((e) => s.decisions.has(e.key) && s.decisions.get(e.key)!.kind !== "skip");
    for (const e of real) {
      const d = s.decisions.get(e.key);
      if (!d || d.kind === "skip") out.push(DIM(`· ${e.title} — ${w.skipped}`));
      else if (d.kind === "approve") out.push(`\x1b[32m✓\x1b[0m ${e.title} — ${w.approved}`);
      else if (d.kind === "correct") out.push(`\x1b[33m✎\x1b[0m ${e.title} — ${w.corrected}: ${d.note}`);
      else out.push(`\x1b[31m✗\x1b[0m ${e.title} — ${w.rejected}${d.note ? `: ${d.note}` : ""}`);
    }
    out.push("", decided.length ? w.signHint : w.nothing, "", buttons(buttonsOf(s)), "", DIM(w.keys));
    return out.join("\n");
  }
  const e = s.entries[s.cur]!;
  const pos = e.start ? "" : ` · ${real.indexOf(e) + 1} / ${real.length}`;
  out.push(`${B("alfred-approve")}${pos}   ${dots(s)}`, "");
  out.push(`${B(e.title)}${e.sub ? DIM(` · ${e.sub}`) : ""}`);
  if (e.why) out.push("", `${DIM(w.why + ":")} ${e.why}`);
  if (e.lines.length) out.push("", ...e.lines);
  out.push("");
  if (s.mode === "note") {
    out.push(s.noteFor === "correct" ? w.noteCorrect : w.noteReject, `> ${s.note}█`);
    if (s.error) out.push(`\x1b[31m${w.noteEmpty}\x1b[0m`);
    out.push("", DIM(w.keysNote));
  } else out.push(buttons(e.buttons), "", DIM(w.keys));
  return out.join("\n");
}
