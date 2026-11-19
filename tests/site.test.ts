/** Site facts, suggestions and the summary: the pure rules, then end to end through perform(). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { ref } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api.js";
import { findLink, parsePage, pricingSignals, siteChanges, suggest, summarize, textOf } from "../feltkit/_site.js";
import { perform, type Call } from "../gateway/worker.js";

const HOME = `<html><head><title>Acme &amp; Co | CRM</title>
<meta name="description" content="The CRM for fast teams.">
<style>.x{}</style></head><body><nav><a href="/pricing">Pricing</a><a href="https://other.com/about">About</a><a href="/company">Company</a></nav>
<h1>Close deals <em>faster</em></h1><script>var a="<h1>no</h1>"</script></body></html>`;
const PRICING = `<main><h2>Free</h2><p>$0</p><h2>Pro</h2><p>$29 per seat</p><h2>Enterprise</h2><p>Contact sales. Start a free trial.</p></main>`;

test("a page's own facts", () => {
  const f = parsePage(HOME, "https://acme.com/");
  assert.equal(f.title, "Acme & Co | CRM");
  assert.equal(f.description, "The CRM for fast teams.");
  assert.equal(f.headline, "Close deals faster");
  assert.equal(findLink(f.links, "acme.com", /\/(pricing|plans)\b/i), "https://acme.com/pricing");
  assert.equal(findLink(f.links, "acme.com", /\/about\b/i), undefined); // other.com is not their site
  assert.equal(textOf("<p>a&nbsp;b</p><script>x</script>"), "a b");
});

test("pricing signals", () => {
  assert.deepEqual(pricingSignals(PRICING), { free: true, trial: true, contactSales: true, prices: ["$0", "$29"], plans: ["Free", "Pro", "Enterprise"] });
});

test("site changes are described", () => {
  const a = { homepage: { url: "u", headline: "Old" }, pricing: { url: "p", free: true, trial: false, contactSales: false, prices: ["$29"], plans: ["Free", "Pro"] } };
  const b = { homepage: { url: "u", headline: "New" }, pricing: { url: "p", free: false, trial: true, contactSales: false, prices: ["$39"], plans: ["Pro", "Team"] } };
  assert.deepEqual(siteChanges(undefined, b), []);
  assert.deepEqual(siteChanges(a, b), ["Homepage headline is now “New”.", "Prices changed: $29 → $39.", "The free plan is gone.", "A free trial appeared.", "New plan names: Team."]);
});

test("suggestions: untracked names, ranked by how many competitors name them", () => {
  const out = suggest(
    [
      { by: "Acme", target: "hubspot", pages: 2 },
      { by: "Beta", target: "HubSpot", pages: 1 },
      { by: "Acme", target: "pipedrive", pages: 5 },
      { by: "Acme", target: "beta", pages: 1 }, // already tracked
      { by: "Acme", target: "mybrand", pages: 1 }, // you
    ],
    ["Acme", "acme.com", "Beta", "beta.io"],
    "MyBrand",
  );
  assert.deepEqual(out.map((x) => [x.name, x.namedBy, x.domainGuess]), [["Hubspot", ["Acme", "Beta"], "hubspot.com"], ["Pipedrive", ["Acme"], "pipedrive.com"]]);
});

test("summary leads with who is aimed at you", () => {
  const s = summarize(
    "MyBrand",
    [{ name: "Acme", domain: "acme.com", snapshot: { urls: 9, completedAt: 1 }, attackTargets: ["mybrand", "hubspot"], targetsYou: 1, markets: ["legal"], addedPages: 4, newMarkets: ["legal"] }],
    [],
  );
  assert.equal(s.headline, "1 competitor is targeting MyBrand. Tracking 1 in total.");
  assert.deepEqual(s.sections.map((x) => x.title), ["Aimed at you", "What moved", "How each competitor positions itself"]);
  assert.match(s.markdown, /^# Competitor summary/);
  assert.equal(summarize("", [], []).headline, "No competitors tracked yet.");
});

test("a capture also reads the homepage, pricing and about pages; suggestions and the summary follow", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    await ada.mutation(api.intel.setBrand, { brand: "MyBrand" });
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    const sm = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://acme.com/vs/mybrand/</loc></url><url><loc>https://acme.com/vs/hubspot/</loc></url><url><loc>https://acme.com/industries/legal/</loc></url></urlset>`;
    const files: Record<string, string> = { "https://acme.com/sitemap.xml": sm, "https://acme.com/": HOME, "https://acme.com/pricing": PRICING };
    const fetchText = async (u: string) => {
      if (!(u in files)) throw new Error("HTTP 404");
      return files[u]!;
    };
    const cap = t.as({ id: "component:capturer", type: "service", roles: ["capturer"] });
    const call: Call = (name, args) => cap.mutation(ref<"mutation">(name), (args ?? {}) as never) as never;
    const snapshotId = await ada.mutation(api.snapshots.request, { competitorId: id });
    assert.equal((await perform(call, fetchText, { snapshotId })).state, "complete");

    const site = await t.query(api.intel.getSite, { competitorId: id });
    assert.equal(site?.homepage.headline, "Close deals faster");
    assert.deepEqual(site?.pricing?.prices, ["$0", "$29"]);
    assert.equal(site?.about, undefined); // /about 404: left out, capture still complete

    assert.deepEqual((await t.query(api.intel.suggestions)).map((x) => x.name), ["Hubspot"]);
    const sum = await t.query(api.intel.summary);
    assert.match(sum.headline, /targeting MyBrand/);
    assert.ok(sum.sections.some((x) => x.title === "Pricing signals"));
    assert.ok(sum.sections.some((x) => x.title === "Worth tracking next"));
  } finally {
    await t.close();
  }
});
