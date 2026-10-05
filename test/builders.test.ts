import { describe, it, expect } from "vitest";
import { all, dns, git, github } from "../src/dsl.ts";
import type { ProbeContext } from "../src/types.ts";

/** A machine whose commands answer from a table keyed by "command args…"; anything else fails. */
function machine(answers: Record<string, { code?: number; stdout: string }>): ProbeContext & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    async fetchText() {
      return { status: 404, headers: new Headers(), body: "" };
    },
    async fileExists() {
      return false;
    },
    async run(cmd, args, cwd) {
      const line = [cmd, ...args].join(" ") + (cwd ? ` (in ${cwd})` : "");
      ran.push(line);
      const a = answers[line];
      return a ? { code: a.code ?? 0, stdout: a.stdout } : { code: 1, stdout: "" };
    },
  };
}
const gh = (path: string, jq: string) => `gh api -i ${path} --jq ${jq}`;
const http = (status: string, body: string) => ({ code: status.startsWith("200") ? 0 : 1, stdout: `HTTP/2.0 ${status}\nContent-Type: application/json\n\n${body}\n` });
const dig = (type: string, name: string, server?: string) => `dig +noall +comments +answer ${server ? `@${server} ` : ""}${type} ${name}`;
const answer = (status: string, ...records: string[]) => ({ stdout: `;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 1\n;; flags: qr rd ra\n\n${records.join("\n")}\n` });

describe("github(repo): through the owner's gh login; unknown is never green", () => {
  const repo = "umutdeveloper/alfredish";
  it("exists only when GitHub answers 200 with that very name", async () => {
    expect(await github(repo).exists().run(machine({ [gh(`repos/${repo}`, ".full_name")]: http("200 OK", repo) }))).toEqual({ ok: true });
    expect(await github(repo).exists().run(machine({ [gh(`repos/${repo}`, ".full_name")]: http("200 OK", "umutdeveloper/other") }))).toEqual({ ok: false, detail: "answered as umutdeveloper/other (renamed or moved)" });
    expect(await github(repo).exists().run(machine({ [gh(`repos/${repo}`, ".full_name")]: http("404 Not Found", "") }))).toEqual({ ok: false, detail: "not found" });
  });

  it("is absent only on a 404 — a failed or refused call is not absence", async () => {
    expect(await github("umutdeveloper/alfred").absent().run(machine({ [gh("repos/umutdeveloper/alfred", ".full_name")]: http("404 Not Found", "") }))).toEqual({ ok: true });
    expect(await github("umutdeveloper/alfred").absent().run(machine({ [gh("repos/umutdeveloper/alfred", ".full_name")]: http("200 OK", "umutdeveloper/alfred") }))).toEqual({ ok: false, detail: "still exists (umutdeveloper/alfred)" });
    expect(await github("umutdeveloper/alfred").absent().run(machine({}))).toEqual({ ok: false, detail: "no answer from GitHub (gh): absence unknown" }); // offline: the old cmd test called this gone
    expect(await github("umutdeveloper/alfred").absent().run(machine({ [gh("repos/umutdeveloper/alfred", ".full_name")]: http("401 Unauthorized", "") }))).toEqual({ ok: false, detail: "GitHub answered 401: absence unknown" });
  });

  it("checks the last commit touching a path", async () => {
    const path = gh("repos/umutdeveloper/esik/commits?path=docs&per_page=1", ".[0].sha");
    expect(await github("umutdeveloper/esik").lastCommitTouching("docs", "8eee4d6").run(machine({ [path]: http("200 OK", "8eee4d6914d3b0a73bf47f7366c7133c91dac712") }))).toEqual({ ok: true });
    expect(await github("umutdeveloper/esik").lastCommitTouching("docs", "8eee4d6").run(machine({ [path]: http("200 OK", "1234567aaaa") }))).toEqual({ ok: false, detail: "last is 1234567" });
  });
});

describe("dns(name, type, { server }): records compared by content; unknown is never green", () => {
  it("contains a value in a record of that type only", async () => {
    const ns = machine({ [dig("NS", "adakocum.com")]: answer("NOERROR", "adakocum.com.\t304\tIN\tNS\ttr.guzelhosting.com.", "adakocum.com.\t304\tIN\tNS\teu.guzelhosting.com.") });
    expect(await dns("adakocum.com", "NS").contains("guzelhosting.com").run(ns)).toEqual({ ok: true });
    expect((await dns("adakocum.com", "NS").contains("cloudflare").run(ns)).ok).toBe(false);
    const cnameOnly = machine({ [dig("A", "www.adakocum.com")]: answer("NOERROR", "www.adakocum.com. 20 IN CNAME jolly-lily-917494.netlify.app.") });
    expect((await dns("www.adakocum.com", "A").contains("netlify").run(cnameOnly)).ok).toBe(false); // a CNAME is not an A record
  });

  it("lacks a value on NOERROR or NXDOMAIN; a failed or refused query is not absence", async () => {
    const server = "tr.guzelhosting.com.";
    const p = dns("zmail._domainkey.adakocum.com", "TXT", { server }).lacks("zoho", "DKIM1");
    expect(await p.run(machine({ [dig("TXT", "zmail._domainkey.adakocum.com", server)]: answer("NXDOMAIN") }))).toEqual({ ok: true });
    expect(await p.run(machine({ [dig("TXT", "zmail._domainkey.adakocum.com", server)]: answer("NOERROR", 'zmail._domainkey.adakocum.com. 300 IN TXT "v=DKIM1; k=rsa; p=MII"') }))).toEqual({ ok: false, detail: 'found "v=dkim1; k=rsa; p=mii"' });
    expect(await p.run(machine({ [dig("TXT", "zmail._domainkey.adakocum.com", server)]: answer("SERVFAIL") }))).toEqual({ ok: false, detail: "SERVFAIL: absence unknown" });
    expect(await p.run(machine({ [dig("TXT", "zmail._domainkey.adakocum.com", server)]: { code: 9, stdout: ";; connection timed out" } }))).toEqual({ ok: false, detail: "dig failed (exit 9): absence unknown" });
    expect(p.describe).toBe('dns TXT zmail._domainkey.adakocum.com at tr.guzelhosting.com. lacks "zoho", "DKIM1"');
  });
});

describe("git(repo).noRemote() and all(...)", () => {
  it("no remote only when git answers with none", async () => {
    expect(await git(".").noRemote().run(machine({ "git remote (in .)": { stdout: "" } }))).toEqual({ ok: true });
    expect(await git(".").noRemote().run(machine({ "git remote (in .)": { stdout: "origin\n" } }))).toEqual({ ok: false, detail: "remotes: origin" });
    expect(await git(".").noRemote().run(machine({}))).toEqual({ ok: false, detail: "not a git repository" });
  });

  it("all passes only when every test passes, names the first failure, and describes every test (K25)", async () => {
    const both = all(git(".").noRemote(), dns("adakocum.com", "A").contains("75.2.60.5"));
    expect(both.describe).toBe('all of: git . has no remote; dns A adakocum.com contains "75.2.60.5"');
    const m = { "git remote (in .)": { stdout: "" }, [dig("A", "adakocum.com")]: answer("NOERROR", "adakocum.com. 20 IN A 75.2.60.5") };
    expect(await both.run(machine(m))).toEqual({ ok: true });
    expect(await both.run(machine({ ...m, "git remote (in .)": { stdout: "origin" } }))).toEqual({ ok: false, detail: "git . has no remote: remotes: origin" });
  });
});
