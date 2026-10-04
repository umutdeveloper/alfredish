import { describe, it, expect } from "vitest";
import { domain, IANA_RDAP_DNS } from "../src/dsl.ts";
import type { ProbeContext, ProbeVerify } from "../src/types.ts";

const BOOT = JSON.stringify({ services: [[["net"], ["https://rdap.example/net/"]], [["com"], ["https://rdap.verisign.com/com/v1/"]]] });
const answer = (expiration?: string) =>
  JSON.stringify({ ldhName: "UMUTCAKIR.COM", events: [{ eventAction: "registration", eventDate: "2016-07-06T21:13:52Z" }, ...(expiration ? [{ eventAction: "expiration", eventDate: expiration }] : [])] });

/** A network that knows IANA's list and one RDAP answer; every other address is 404. */
function net(pages: Record<string, string>): ProbeContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async fetchText(url) {
      asked.push(url);
      const body = pages[url];
      return { status: body === undefined ? 404 : 200, headers: new Headers(), body: body ?? "" };
    },
    async fileExists() {
      return false;
    },
    async run() {
      return { code: 1, stdout: "" };
    },
  };
}
const RDAP = "https://rdap.verisign.com/com/v1/domain/umutcakir.com";
const run = (p: ProbeVerify, ctx: ProbeContext) => p.run(ctx);

describe("domain(name).expiresOnOrAfter(date): registration end compared as dates (RDAP)", () => {
  it("passes when the registration ends on or after the date, and asks the server IANA lists for the TLD", async () => {
    const ctx = net({ [IANA_RDAP_DNS]: BOOT, [RDAP]: answer("2027-07-06T21:13:52Z") });
    expect(await run(domain("umutcakir.com").expiresOnOrAfter("2027-07-06"), ctx)).toEqual({ ok: true });
    expect(ctx.asked).toEqual([IANA_RDAP_DNS, RDAP]);
  });

  it("fails a date the old whois regex accepted: 2027-07-03 is not on or after 2027-07-06", async () => {
    const oldRegex = /Registry Expiry Date: (2027-0[7-9]|2027-1|20(2[8-9]|[3-9]\d))/;
    expect(oldRegex.test("Registry Expiry Date: 2027-07-03T21:13:52Z")).toBe(true); // the bug this test kind removes
    const r = await run(domain("umutcakir.com").expiresOnOrAfter("2027-07-06"), net({ [IANA_RDAP_DNS]: BOOT, [RDAP]: answer("2027-07-03T21:13:52Z") }));
    expect(r).toEqual({ ok: false, detail: "ends 2027-07-03T21:13:52Z" });
  });

  it("fails the day after the registration ends", async () => {
    const r = await run(domain("umutcakir.com").expiresOnOrAfter("2027-07-07"), net({ [IANA_RDAP_DNS]: BOOT, [RDAP]: answer("2027-07-06T21:13:52Z") }));
    expect(r.ok).toBe(false);
  });

  it("is red with the reason when the end cannot be known — never green by default", async () => {
    const p = domain("umutcakir.com").expiresOnOrAfter("2027-07-06");
    expect(await run(p, net({ [IANA_RDAP_DNS]: BOOT }))).toEqual({ ok: false, detail: "RDAP answered 404" });
    expect(await run(p, net({ [IANA_RDAP_DNS]: BOOT, [RDAP]: answer() }))).toEqual({ ok: false, detail: "RDAP gives no expiration date" });
    expect(await run(p, net({ [IANA_RDAP_DNS]: BOOT, [RDAP]: "<html>not json</html>" }))).toEqual({ ok: false, detail: "RDAP gives no expiration date" });
    expect(await run(p, net({ [IANA_RDAP_DNS]: BOOT, [RDAP]: answer("soon") }))).toEqual({ ok: false, detail: "RDAP gives no expiration date" });
    expect(await run(domain("ada.study").expiresOnOrAfter("2027-01-01"), net({ [IANA_RDAP_DNS]: BOOT }))).toEqual({ ok: false, detail: "no RDAP server for .study in IANA's list" });
    expect(await run(p, net({}))).toEqual({ ok: false, detail: "no RDAP server for .com in IANA's list" });
  });

  it("refuses a date that does not exist, and its description names the domain, the date and the source (K25)", () => {
    expect(() => domain("umutcakir.com").expiresOnOrAfter("2027-02-30")).toThrow("not a real date: 2027-02-30");
    expect(() => domain("umutcakir.com").expiresOnOrAfter("2027-7-6" as "2027-07-06")).toThrow("not a real date");
    expect(domain("umutcakir.com").expiresOnOrAfter("2027-07-06").describe).toBe("domain umutcakir.com registration ends on or after 2027-07-06 (RDAP)");
  });
});
