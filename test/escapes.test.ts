import { describe, it, expect } from "vitest";
import { typeEscapes } from "../src/escapes.ts";

const whats = (src: string) => typeEscapes(src).map((e) => `${e.line}:${e.what}`);

describe("K17 — type escapes", () => {
  it("finds every escape in code, with its line", () => {
    const src = [
      'const a = "x" as any;',
      "const b = y as unknown as string;",
      "let c: any = 1;",
      "function f(x: any) {}",
      "const d = <any>e;",
      "// @ts-ignore",
      "/* @ts-expect-error */",
      " * @ts-nocheck",
    ].join("\n");
    expect(whats(src)).toEqual(["1:as any", "2:as unknown", "3:any type", "4:any type", "5:any type", "6:@ts-ignore", "7:@ts-expect-error"]);
  });

  it("a // @ts-nocheck file directive is found", () => {
    expect(whats("// @ts-nocheck\nexport const x = 1;")).toEqual(["1:@ts-nocheck"]);
  });

  it("ignores the words in strings, templates, regular expressions and ordinary comments", () => {
    const src = [
      'const a = "never write as any here";',
      "const b = 'x as unknown';",
      "const c = `as any ${'nested as any'} still text`;",
      "const r = /as any|\\/\"as any\"/g;",
      "// do not use as any; @ts-ignore only counts at the start",
      "/* a comment about as unknown */",
      "const o = { any: 1, other: 2 };",
      "const p = o.any;",
    ].join("\n");
    expect(whats(src)).toEqual([]);
  });

  it("code after a template with nested braces is still read as code", () => {
    const src = "const t = `a ${ { k: 1 }.k } b`;\nconst z = 1 as any;";
    expect(whats(src)).toEqual(["2:as any"]);
  });

  it("a division is not taken for a regular expression", () => {
    const src = "const half = total / 2; const q = (a) / b;\nconst w = v as any;";
    expect(whats(src)).toEqual(["2:as any"]);
  });

  it("TypeScript's parser settles the hard cases: a regex with // and quotes, a regex after a closing parenthesis", () => {
    const src = [
      'const r = /\\/\\/ @ts-ignore "as any"/;',
      "if (ok) /as any/.test(x);",
      "const n = (a + b) / 2 / c;",
      "const w = v as any;",
    ].join("\n");
    expect(whats(src)).toEqual(["4:as any"]);
  });
});

describe("K25 — a test says everything it does", () => {
  it("importing or calling probe is found, also under another name; the word in text is not", () => {
    const src = [
      'import { probe as p, cmd } from "./lang.ts";',
      "const t = probe(\"x\", async () => ({ ok: true }));",
      'const note = "we never call probe here";',
    ].join("\n");
    expect(whats(src)).toEqual(["1:imports probe (K25: use page, http, header, file, git, domain or cmd)", "2:calls probe (K25: use page, http, header, file, git, domain or cmd)"]);
  });

  it("cmd and git describe everything they run and expect, so the hash covers it", async () => {
    const { cmd, git } = await import("../src/dsl.ts");
    expect(cmd("the folder exists", "sh", ["-c", 'test -d "$0/git"', "/x"], /ok/).describe).toBe('the folder exists — runs: sh -c "test -d \\"$0/git\\"" /x expect /ok/');
    expect(cmd("always", "true", []).describe).toBe("always — runs: true");
    expect(git(".").lastCommitMatches(/^\d{4}/, "starts with a year").describe).toBe("git . last commit starts with a year (matches /^\\d{4}/)");
  });
});
