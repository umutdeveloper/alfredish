// A fictional memory, to show the language. No real person's data.
import { account, asset, claim, decision, fact, header, http, key, page, review, session, url } from "../vendor/alfredish/src/index.ts";

export const s1 = session({
  id: "s.2026-01-10", title: "Set up the public site", at: "2026-01-10",
  topic: "Set up the public site", questions: ["Is the site live?", "What do we promise on it?"],
});

export const host = account({
  id: "hosting.main", title: "Hosting account", origin: s1,
  service: "example-host", owner: "owner", login: "owner@example.com", agentAccess: "none",
  verify: review({ by: "owner", at: "2026-01-10", every: "3650d" }), evidence: "human",
});

export const site = asset({
  id: "site.live", title: "The public site is up", origin: s1, on: host,
  desired: "online", location: url("https://example.com/"),
  verify: http("https://example.com/").status(200), evidence: "live",
});

export const siteDomainKey = key({ subject: "site", name: "domainOwner", valueType: "text", describe: "who the site domain belongs to", origin: s1 });
export const siteContentTypeKey = key({ subject: "site", name: "contentType", valueType: "text", describe: "media type the site serves", origin: s1, distinctFrom: [siteDomainKey] });

export const isExample = fact({
  id: "site.isExampleDomain", key: siteDomainKey, title: "The site is the IANA example domain", origin: s1,
  value: true, verify: page("https://example.com/").contains("Example Domain"), evidence: "live",
});

export const htmlServed = fact({
  id: "site.servesHtml", key: siteContentTypeKey, title: "The site serves HTML", origin: s1,
  value: "text/html", verify: header("https://example.com/", "content-type").contains("text/html"), evidence: "live",
});

export const keepItSimple = decision({
  id: "site.keepSimple", title: "Keep the site a single static page", origin: s1,
  restsOn: [site, htmlServed], review: "3650d",
  verify: review({ by: "owner", at: "2026-01-10", every: "3650d" }), evidence: "human",
});

export const heading = claim({
  id: "site.heading", title: "The page says what it is", origin: s1,
  text: "Example Domain", where: url("https://example.com/"), restsOn: [isExample, keepItSimple],
  verify: page("https://example.com/").contains("Example Domain"), evidence: "live",
});
