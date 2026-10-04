// K17: no type escapes in a memory. Uses TypeScript's own parser: `any` / `unknown` are found as syntax-tree nodes,
// directives as the comments the parser attaches to tokens, so text inside strings, templates or regular expressions
// is never mistaken for code.
import ts from "typescript";

export interface Escape {
  line: number;
  what: string;
}

const DIRECTIVE = /^(?:\/\/+|\/\*+)[\s*]*@(ts-ignore|ts-expect-error|ts-nocheck)\b/;

/** Every type escape in a TypeScript source: `as any`, `as unknown`, an `any` type, and @ts-ignore-style directives. */
export function typeEscapes(src: string, fileName = "memory.ts"): Escape[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Escape[] = [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const seenComments = new Set<number>();
  const comments = (pos: number) => {
    for (const r of [...(ts.getLeadingCommentRanges(src, pos) ?? []), ...(ts.getTrailingCommentRanges(src, pos) ?? [])]) {
      if (seenComments.has(r.pos)) continue;
      seenComments.add(r.pos);
      const m = DIRECTIVE.exec(src.slice(r.pos, r.end));
      if (m) out.push({ line: lineOf(r.pos), what: `@${m[1]}` });
    }
  };
  const visit = (node: ts.Node) => {
    comments(node.getFullStart());
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      out.push({ line: lineOf(node.getStart(sf)), what: ts.isAsExpression(node.parent) ? "as any" : "any type" });
    }
    if (node.kind === ts.SyntaxKind.UnknownKeyword && ts.isAsExpression(node.parent)) {
      out.push({ line: lineOf(node.getStart(sf)), what: "as unknown" });
    }
    // Tokens are children too (getChildren), so every comment position between tokens is visited.
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  comments(sf.endOfFileToken.getFullStart());
  return out.sort((a, b) => a.line - b.line || a.what.localeCompare(b.what));
}
