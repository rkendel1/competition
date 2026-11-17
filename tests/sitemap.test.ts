/** The pure rules in feltkit/_sitemap.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bidTerms, brandKey, checkFetchableUrl, classify, defaultSitemapUrl, diffUrls, domainOf, lastmodMs, parseSitemap, targetOf, targetsBrand } from "../feltkit/_sitemap.js";

test("parses a urlset with namespaces, CDATA, entities and extensions", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
    <url><loc>https://acme.com/vs/hubspot/</loc><lastmod>2026-11-02</lastmod><image:image><image:loc>https://acme.com/a.png</image:loc></image:image></url>
    <url><loc><![CDATA[https://acme.com/a?x=1&y=2]]></loc></url>
    <url><loc>https://acme.com/b?x=1&amp;y=2</loc><lastmod> 2026-10-01T10:00:00+00:00 </lastmod></url>
    <url><lastmod>2026-01-01</lastmod></url>
  </urlset>`;
  const p = parseSitemap(xml);
  assert.equal(p.kind, "urlset");
  assert.deepEqual(p.entries, [
    { loc: "https://acme.com/vs/hubspot/", lastmod: "2026-11-02" },
    { loc: "https://acme.com/a?x=1&y=2" },
    { loc: "https://acme.com/b?x=1&y=2", lastmod: "2026-10-01T10:00:00+00:00" },
  ]);
});

test("parses a sitemap index and refuses non-sitemaps", () => {
  const p = parseSitemap(`<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap><sitemap><loc>https://x.com/s2.xml.gz</loc><lastmod>2026-11-01</lastmod></sitemap></sitemapindex>`);
  assert.equal(p.kind, "index");
  assert.deepEqual(p.entries.map((e) => e.loc), ["https://x.com/s1.xml", "https://x.com/s2.xml.gz"]);
  assert.deepEqual(parseSitemap("<html><body>Not found</body></html>"), { kind: "unknown", entries: [] });
});

test("lastmod accepts W3C dates only", () => {
  assert.equal(lastmodMs("2026-11-02"), Date.UTC(2026, 10, 2));
  assert.ok(lastmodMs("2026-11-02T08:00:00Z"));
  assert.ok(lastmodMs("2026-11"));
  assert.equal(lastmodMs("yesterday"), undefined);
  assert.equal(lastmodMs(undefined), undefined);
});

test("classifies section directories and slug forms", () => {
  assert.deepEqual(classify("https://a.com/vs/hubspot/"), ["vs"]);
  assert.deepEqual(classify("https://a.com/compare/acme-vs-hubspot"), ["vs"]);
  assert.deepEqual(classify("https://a.com/blog/acme-vs-hubspot"), ["vs"]);
  assert.deepEqual(classify("https://a.com/alternative/salesforce"), ["alternative"]);
  assert.deepEqual(classify("https://a.com/hubspot-alternatives"), ["alternative"]);
  assert.deepEqual(classify("https://a.com/industries/healthcare/"), ["industry"]);
  assert.deepEqual(classify("https://a.com/solutions/enterprise"), ["solution"]);
  assert.deepEqual(classify("https://a.com/use-cases/onboarding"), ["solution"]);
  assert.deepEqual(classify("https://a.com/de/industries/"), ["industry"]);
  // Not fooled by words that merely contain the patterns.
  assert.deepEqual(classify("https://a.com/blog/canvas-tips"), []);
  assert.deepEqual(classify("https://a.com/blog/vsco-review"), []);
  assert.deepEqual(classify("https://a.com/pricing"), []);
});

test("extracts whom a page targets, skipping the competitor's own name", () => {
  assert.equal(targetOf("https://acme.com/vs/hubspot/", "Acme"), "hubspot");
  assert.equal(targetOf("https://acme.com/vs/acme-vs-hubspot", "Acme"), "hubspot");
  assert.equal(targetOf("https://acme.com/compare/hubspot-vs-acme", "acme.com"), "hubspot");
  assert.equal(targetOf("https://acme.com/alternatives/salesforce-alternative", "Acme"), "salesforce");
  assert.equal(targetOf("https://acme.com/alternative-to-pipedrive", "Acme"), "pipedrive");
  assert.equal(targetOf("https://acme.com/alternatives/zoho-crm/", "Acme"), "zoho crm");
  assert.equal(targetOf("https://acme.com/vs/", "Acme"), undefined);
  assert.equal(targetOf("https://acme.com/en/vs/", "Acme"), undefined);
});

test("brand matching tolerates case, spacing and TLDs", () => {
  assert.equal(brandKey("Acme.io"), "acme");
  assert.equal(brandKey("https://www.Acme.com/"), "acme");
  assert.ok(targetsBrand("zoho crm", "Zoho-CRM"));
  assert.ok(!targetsBrand("hubspot", ""));
  assert.ok(!targetsBrand(undefined, "acme"));
});

test("diffs snapshots deterministically", () => {
  assert.deepEqual(diffUrls(["a", "b", "c"], ["c", "d", "b", "e"]), { added: ["d", "e"], removed: ["a"] });
});

test("bid terms need your brand", () => {
  assert.deepEqual(bidTerms("", "Acme"), []);
  assert.deepEqual(bidTerms("Mine", "Acme"), ["Mine vs Acme", "Acme vs Mine", "Acme alternative", "Acme alternatives"]);
});

test("normalises what a person types", () => {
  assert.equal(defaultSitemapUrl("acme.com"), "https://acme.com/sitemap.xml");
  assert.equal(defaultSitemapUrl("https://www.acme.com/pricing"), "https://www.acme.com/sitemap.xml");
  assert.equal(defaultSitemapUrl("https://acme.com/sitemap_index.xml"), "https://acme.com/sitemap_index.xml");
  assert.equal(domainOf("https://WWW.Acme.com/x"), "acme.com");
});

test("refuses private and non-web URLs", () => {
  assert.throws(() => checkFetchableUrl("file:///etc/passwd"), /http/);
  assert.throws(() => checkFetchableUrl("http://localhost:3000/sitemap.xml"), /private/);
  assert.throws(() => checkFetchableUrl("http://169.254.169.254/latest"), /private/);
  assert.throws(() => checkFetchableUrl("http://10.0.0.5/sitemap.xml"), /private/);
  assert.throws(() => checkFetchableUrl("http://[::1]/sitemap.xml"), /private/);
  assert.throws(() => checkFetchableUrl("https://user:pw@acme.com/sitemap.xml"), /credentials/);
  assert.equal(checkFetchableUrl("https://acme.com/sitemap.xml").hostname, "acme.com");
  assert.equal(checkFetchableUrl("http://127.0.0.1:8080/s.xml", true).port, "8080");
});
