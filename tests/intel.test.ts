/**
 * End to end against a real FeltDB instance per test: capture (pasted and fetched), the report,
 * diffs between snapshots, roles, and the private-network guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const urlset = (rows: Array<[string, string?]>) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows
    .map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`)
    .join("")}</urlset>`;

const OCTOBER = urlset([
  ["https://acme.com/", "2026-01-10"],
  ["https://acme.com/pricing", "2026-09-01"],
  ["https://acme.com/vs/hubspot/", "2026-06-01"],
  ["https://acme.com/alternatives/salesforce-alternative", "2026-05-01"],
  ["https://acme.com/industries/healthcare/", "2026-03-01"],
  ["https://acme.com/blog/old-post", "2025-01-01"],
]);

const NOVEMBER = urlset([
  ["https://acme.com/", "2026-11-10"],
  ["https://acme.com/pricing", "2026-09-01"],
  ["https://acme.com/vs/hubspot/", "2026-06-01"],
  ["https://acme.com/vs/mybrand/", "2026-11-12"],
  ["https://acme.com/compare/acme-vs-pipedrive", "2026-11-03"],
  ["https://acme.com/alternatives/salesforce-alternative", "2026-05-01"],
  ["https://acme.com/industries/healthcare/", "2026-03-01"],
  ["https://acme.com/industries/legal/", "2026-11-14"],
  ["https://acme.com/solutions/enterprise", "2026-11-01"],
]);

const NOV_15 = Date.UTC(2026, 10, 15);

test("pasted snapshots produce targets, markets, changes and a diff", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    await ada.mutation(api.intel.setBrand, { brand: "MyBrand" });
    const id = await ada.mutation(api.intel.addCompetitor, { site: "https://www.acme.com/" });
    await assert.rejects(ada.mutation(api.intel.addCompetitor, { site: "acme.com" }), { code: "CONFLICT" });

    const first = await ada.action(api.capture.run, { competitorId: id, xml: OCTOBER });
    assert.equal(first.state, "complete");
    assert.equal(first.urlCount, 6);

    const second = await ada.action(api.capture.run, { competitorId: id, xml: NOVEMBER });
    assert.equal(second.state, "complete");
    assert.equal((second as { newSignals?: number }).newSignals, 4); // vs/mybrand, acme-vs-pipedrive, industries/legal, solutions/enterprise
    assert.equal((second as { newTargetingYou?: number }).newTargetingYou, 1);

    await t.restart(); // durable: the report is derived from what was committed
    const r = await t.as("grace").query(api.intel.report, { competitorId: id, now: NOV_15 });
    assert.equal(r.competitor.name, "Acme");
    assert.equal(r.totals.urls, 9);
    assert.deepEqual({ vs: r.totals.vs, alternative: r.totals.alternative, industry: r.totals.industry, solution: r.totals.solution }, { vs: 3, alternative: 1, industry: 2, solution: 1 });
    assert.deepEqual({ added: r.totals.added, removed: r.totals.removed }, { added: 4, removed: 1 });
    assert.deepEqual(r.removed, ["https://acme.com/blog/old-post"]);

    // Pages aimed at you come first.
    assert.equal(r.attacks[0]!.url, "https://acme.com/vs/mybrand/");
    assert.equal(r.attacks[0]!.targetsYou, true);
    assert.equal(r.attacks[0]!.isNew, true);
    assert.deepEqual(r.targets.map((x) => [x.name, x.targetsYou]), [["mybrand", true], ["hubspot", false], ["pipedrive", false], ["salesforce", false]]);

    // Changed in the last 30 days, newest first.
    assert.deepEqual(r.recent.map((x) => x.path), ["/industries/legal/", "/vs/mybrand/", "/", "/compare/acme-vs-pipedrive", "/solutions/enterprise"]);
    assert.deepEqual(r.markets.map((x) => x.path), ["/industries/legal/", "/solutions/enterprise", "/industries/healthcare/"]);
    assert.deepEqual(r.bidTerms, ["MyBrand vs Acme", "Acme vs MyBrand", "Acme alternative", "Acme alternatives"]);

    const [c] = await ada.query(api.intel.listCompetitors);
    assert.equal(c!.snapshotCount, 2);
    assert.equal(c!.lastUrlCount, 9);
  } finally {
    await t.close();
  }
});

test("viewers read; they cannot add competitors or capture", async () => {
  const t = await createTestApp();
  try {
    const id = await t.as("ada").mutation(api.intel.addCompetitor, { site: "acme.com" });
    const grace = t.as("grace");
    assert.equal((await grace.query(api.intel.listCompetitors)).length, 1);
    await assert.rejects(grace.mutation(api.intel.addCompetitor, { site: "other.com" }), { code: "FORBIDDEN" });
    await assert.rejects(grace.action(api.capture.run, { competitorId: id, xml: OCTOBER }), { code: "FORBIDDEN" });
    await assert.rejects(t.query(api.intel.listCompetitors), { code: "UNAUTHORIZED" });
  } finally {
    await t.close();
  }
});

test("a document that is not a sitemap fails honestly and is never reported", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    const r = await ada.action(api.capture.run, { competitorId: id, xml: "<html>404</html>" });
    assert.equal(r.state, "failed");
    assert.match(r.problems.join(" "), /not a sitemap/);
    const report = await ada.query(api.intel.report, { competitorId: id });
    assert.equal(report.snapshot, undefined);
    const [snap] = await ada.query(api.intel.listSnapshots, { competitorId: id });
    assert.equal(snap!.state, "failed");
  } finally {
    await t.close();
  }
});

async function serve(routes: Record<string, { status?: number; body?: string | Buffer; headers?: Record<string, string> }>): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const r = routes[req.url ?? ""];
    if (!r) return res.writeHead(404).end("not found");
    res.writeHead(r.status ?? 200, { "content-type": "application/xml", ...(r.headers ?? {}) }).end(r.body ?? "");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test("fetches an index, follows a redirect, reads a gzipped child, and falls back to robots.txt", async () => {
  const routes: Record<string, { status?: number; body?: string | Buffer; headers?: Record<string, string> }> = {};
  const { server, base } = await serve(routes);
  Object.assign(routes, {
    "/robots.txt": { body: `User-agent: *\nSitemap: ${base}/old-index.xml\n`, headers: { "content-type": "text/plain" } },
    "/old-index.xml": { status: 301, headers: { location: "/sitemap_index.xml" } },
    "/sitemap_index.xml": { body: `<sitemapindex><sitemap><loc>${base}/pages.xml.gz</loc></sitemap><sitemap><loc>${base}/missing.xml</loc></sitemap></sitemapindex>` },
    "/pages.xml.gz": { body: gzipSync(NOVEMBER), headers: { "content-type": "application/gzip" } },
  });
  process.env.SITEMAP_INTEL_ALLOW_PRIVATE = "1";
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    // /sitemap.xml 404s on the test server, so robots.txt is read instead.
    await ada.mutation(api.intel.updateCompetitor, { id, sitemapUrl: `${base}/sitemap.xml` });
    const r = await ada.action(api.capture.run, { competitorId: id });
    assert.equal(r.state, "complete", r.problems.join("\n"));
    assert.equal(r.urlCount, 9);
    assert.match(r.problems.join("\n"), /robots\.txt/);
    assert.match(r.problems.join("\n"), /missing\.xml: HTTP 404/);
    const [snap] = await ada.query(api.intel.listSnapshots, { competitorId: id });
    assert.deepEqual(snap!.filesRead, [`${base}/old-index.xml`, `${base}/pages.xml.gz`]);
  } finally {
    delete process.env.SITEMAP_INTEL_ALLOW_PRIVATE;
    await t.close();
    server.close();
  }
});

test("never fetches private addresses outside development fixtures", async () => {
  const { server, base } = await serve({ "/sitemap.xml": { body: OCTOBER } });
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    await ada.mutation(api.intel.updateCompetitor, { id, sitemapUrl: `${base}/sitemap.xml` });
    const r = await ada.action(api.capture.run, { competitorId: id });
    assert.equal(r.state, "failed");
    assert.match(r.problems.join(" "), /private/);
  } finally {
    await t.close();
    server.close();
  }
});

test("large sitemaps: 20,000 URLs in batches, reported and deleted", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "big.com" });
    const N = 20_000;
    const rows: Array<[string, string]> = [];
    for (let i = 0; i < N; i++) rows.push([`https://big.com/blog/post-${i}`, "2026-10-01"]);
    rows.push(["https://big.com/vs/mybrand", "2026-11-10"]);
    let started = Date.now();
    const r = await ada.action(api.capture.run, { competitorId: id, xml: urlset(rows) });
    const captureMs = Date.now() - started;
    assert.equal(r.urlCount, N + 1);
    started = Date.now();
    const report = await ada.query(api.intel.report, { competitorId: id });
    const reportMs = Date.now() - started;
    assert.equal(report.totals.vs, 1);
    console.log(`capture ${captureMs} ms, report ${reportMs} ms`);
    let remaining = 1;
    while (remaining) remaining = (await ada.mutation(api.intel.deleteSnapshot, { id: r.snapshotId })).remaining;
    await ada.mutation(api.intel.removeCompetitor, { id });
    assert.equal((await ada.query(api.intel.listCompetitors)).length, 0);
  } finally {
    await t.close();
  }
});
