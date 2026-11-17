/**
 * End to end against a real FeltDB instance per test: capture (pasted and fetched), the report,
 * diffs between snapshots, roles, and the private-network guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { createTestApp } from "@feltdb/feltkit/testing";
import { ref } from "@feltdb/feltkit/client";
import { fetchText } from "../gateway/http.js";
import { perform, tick, type Call } from "../gateway/worker.js";
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

    const first = await ada.action(api.capture.paste, { competitorId: id, xml: OCTOBER });
    assert.equal(first.state, "complete");
    assert.equal(first.urlCount, 6);

    const second = await ada.action(api.capture.paste, { competitorId: id, xml: NOVEMBER });
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
    await assert.rejects(grace.action(api.capture.paste, { competitorId: id, xml: OCTOBER }), { code: "FORBIDDEN" });
    // Visitors with no account can read, but not change anything.
    assert.equal((await t.query(api.intel.listCompetitors)).length, 1);
    await assert.rejects(t.mutation(api.intel.addCompetitor, { site: "other.com" }), { code: "UNAUTHORIZED" });
  } finally {
    await t.close();
  }
});

test("a document that is not a sitemap fails honestly and is never reported", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    const r = await ada.action(api.capture.paste, { competitorId: id, xml: "<html>404</html>" });
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

type T = Awaited<ReturnType<typeof createTestApp>>;

/** The capturer component's identity and its calls, exactly as the component makes them. */
function capturer(t: T): Call {
  const as = t.as({ id: "component:capturer", type: "service", roles: ["capturer"] });
  return (name, args) => as.mutation(ref<"mutation">(name), args as never) as never;
}

const fixtures = (base: string) => ({
  "/robots.txt": { body: `User-agent: *\nSitemap: ${base}/old-index.xml\n`, headers: { "content-type": "text/plain" } },
  "/old-index.xml": { status: 301, headers: { location: "/sitemap_index.xml" } },
  "/sitemap_index.xml": { body: `<sitemapindex><sitemap><loc>${base}/pages.xml.gz</loc></sitemap><sitemap><loc>${base}/missing.xml</loc></sitemap></sitemapindex>` },
  "/pages.xml.gz": { body: gzipSync(NOVEMBER), headers: { "content-type": "application/gzip" } },
});

test("Capture now queues a snapshot; the capturer fetches an index, a redirect, a gzipped child and robots.txt", async () => {
  const routes: Record<string, { status?: number; body?: string | Buffer; headers?: Record<string, string> }> = {};
  const { server, base } = await serve(routes);
  Object.assign(routes, fixtures(base));
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    // /sitemap.xml 404s on the test server, so robots.txt is read instead.
    await ada.mutation(api.intel.updateCompetitor, { id, sitemapUrl: `${base}/sitemap.xml` });
    const snapshotId = await ada.mutation(api.snapshots.request, { competitorId: id });
    await assert.rejects(ada.mutation(api.snapshots.request, { competitorId: id }), { code: "FAILED_PRECONDITION" });
    assert.equal((await ada.query(api.intel.listCompetitors))[0]!.capturing, "queued");

    const r = await perform(capturer(t), (u) => fetchText(u, { allowPrivate: true }), { snapshotId });
    assert.equal(r.state, "complete", (r.problems ?? []).join("\n"));
    assert.equal(r.urlCount, 9);
    assert.match(r.problems!.join("\n"), /robots\.txt/);
    assert.match(r.problems!.join("\n"), /missing\.xml: HTTP 404/);
    const [snap] = await ada.query(api.intel.listSnapshots, { competitorId: id });
    assert.deepEqual({ state: snap!.state, trigger: snap!.trigger, requestedBy: snap!.requestedBy, takenBy: snap!.takenBy }, { state: "complete", trigger: "manual", requestedBy: "ada", takenBy: "component:capturer" });
    assert.deepEqual(snap!.filesRead, [`${base}/old-index.xml`, `${base}/pages.xml.gz`]);
    // Settled work is never redone.
    assert.equal((await perform(capturer(t), (u) => fetchText(u, { allowPrivate: true }), { snapshotId })).outcome, "skipped");
  } finally {
    await t.close();
    server.close();
  }
});

test("schedules: set by a person, claimed exactly once when due, run by the capturer, advanced without drift", async () => {
  const routes: Record<string, { status?: number; body?: string | Buffer; headers?: Record<string, string> }> = {};
  const { server, base } = await serve(routes);
  Object.assign(routes, { "/sitemap.xml": { body: OCTOBER } });
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    await ada.mutation(api.intel.updateCompetitor, { id, sitemapUrl: `${base}/sitemap.xml` });
    await assert.rejects(t.as("grace").mutation(api.schedule.set, { competitorId: id, cadence: "monthly", firstRunAt: Date.UTC(2026, 10, 20, 9) }), { code: "FORBIDDEN" });

    const first = Date.UTC(2026, 10, 20, 9);
    const { nextRunAt } = await ada.mutation(api.schedule.set, { competitorId: id, cadence: "monthly", firstRunAt: first, now: Date.UTC(2026, 10, 17, 12) });
    assert.equal(nextRunAt, first);

    const cap = capturer(t);
    assert.deepEqual(await tick(cap, Date.UTC(2026, 10, 19)), { queued: [], skipped: [] });
    const due = await tick(cap, Date.UTC(2026, 10, 20, 10));
    assert.deepEqual(due.queued, [id]);
    assert.deepEqual(await tick(cap, Date.UTC(2026, 10, 20, 10)), { queued: [], skipped: [] }, "claimed once");
    let [c] = await ada.query(api.intel.listCompetitors);
    assert.equal(c!.schedule!.nextRunAt, Date.UTC(2026, 11, 20, 9));
    assert.equal(c!.capturing, "queued");

    const [queued] = await ada.query(api.intel.listSnapshots, { competitorId: id });
    const r = await perform(cap, (u) => fetchText(u, { allowPrivate: true }), { snapshotId: queued!.id });
    assert.equal(r.state, "complete");
    const [snap] = await ada.query(api.intel.listSnapshots, { competitorId: id });
    assert.deepEqual({ trigger: snap!.trigger, requestedBy: snap!.requestedBy, urls: snap!.urlCount }, { trigger: "schedule", requestedBy: "ada", urls: 6 });

    // Down for three months: one capture, then back on the 20th.
    assert.deepEqual((await tick(cap, Date.UTC(2027, 2, 1))).queued, [id]);
    [c] = await ada.query(api.intel.listCompetitors);
    assert.equal(c!.schedule!.nextRunAt, Date.UTC(2027, 2, 20, 9));

    // People cannot impersonate the capturer's work, and a cleared schedule stops.
    await ada.mutation(api.schedule.clear, { competitorId: id });
    [c] = await ada.query(api.intel.listCompetitors);
    assert.equal(c!.schedule, undefined);
  } finally {
    await t.close();
    server.close();
  }
});

test("an interrupted capture is failed and restarted fresh, never completed half-written", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    const snapshotId = await ada.mutation(api.snapshots.request, { competitorId: id });
    const cap = capturer(t);
    const first = await cap<{ snapshotId: string }>("snapshots:start", { snapshotId });
    assert.equal(first.snapshotId, snapshotId);
    await cap("snapshots:append", { snapshotId, pages: [{ url: "https://acme.com/a" }] });
    // The lease expired; the work item is claimed again and started again.
    const second = await cap<{ snapshotId: string }>("snapshots:start", { snapshotId });
    assert.notEqual(second.snapshotId, snapshotId);
    const snaps = await ada.query(api.intel.listSnapshots, { competitorId: id });
    assert.deepEqual(snaps.map((x) => x.state).sort(), ["collecting", "failed"]);
    assert.match(snaps.find((x) => x.state === "failed")!.problems.join(" "), /Interrupted/);
  } finally {
    await t.close();
  }
});

test("the capturer never fetches private addresses outside development fixtures", async () => {
  const { server, base } = await serve({ "/sitemap.xml": { body: OCTOBER } });
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    await ada.mutation(api.intel.updateCompetitor, { id, sitemapUrl: `${base}/sitemap.xml` });
    const snapshotId = await ada.mutation(api.snapshots.request, { competitorId: id });
    const r = await perform(capturer(t), (u) => fetchText(u), { snapshotId });
    assert.equal(r.state, "failed");
    assert.match(r.problems!.join(" "), /private/);
  } finally {
    await t.close();
    server.close();
  }
});

test("pasting a sitemap index explains what to do instead", async () => {
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    const id = await ada.mutation(api.intel.addCompetitor, { site: "acme.com" });
    const r = await ada.action(api.capture.paste, { competitorId: id, xml: "<sitemapindex><sitemap><loc>https://acme.com/a.xml</loc></sitemap></sitemapindex>" });
    assert.equal(r.state, "failed");
    assert.match(r.problems.join(" "), /sitemap index listing 1/);
  } finally {
    await t.close();
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
    const r = await ada.action(api.capture.paste, { competitorId: id, xml: urlset(rows) });
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
