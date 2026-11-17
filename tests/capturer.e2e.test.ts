/**
 * The capturer as it really runs: `feltkit dev` starts the component inside the application, a
 * person (Ada) sets a schedule from a browser-style client, and the capture happens on its own:
 * no API key, no cron, no further request from anyone. Then "Capture now" goes through the same
 * path. Reads fixtures from a local server, so SITEMAP_INTEL_ALLOW_PRIVATE=1 (development only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api.js";

const SITEMAP = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://acme.com/vs/mybrand/</loc><lastmod>2026-11-12</lastmod></url>
<url><loc>https://acme.com/industries/legal/</loc><lastmod>2026-11-14</lastmod></url>
<url><loc>https://acme.com/pricing</loc></url></urlset>`;

const exitedRef = { value: false };

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    if (exitedRef.value) throw new Error(`The dev server exited while waiting for ${what}`);
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("a schedule set in the app runs by itself through the capturer component, with no API key", { timeout: 120_000 }, async () => {
  const fixture = createServer((req, res) => (req.url === "/sitemap.xml" ? res.writeHead(200, { "content-type": "application/xml" }).end(SITEMAP) : res.writeHead(404).end()));
  await new Promise<void>((ok) => fixture.listen(0, "127.0.0.1", ok));
  const sitemapUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/sitemap.xml`;
  const state = mkdtempSync(join(tmpdir(), "sitemap-intel-e2e-"));

  // A clean environment: the test runner's own FELTKIT_* settings belong to the test environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FELTKIT_") && !k.startsWith("FELTDB_")));
  const dev = spawn(process.execPath, ["node_modules/@feltdb/feltkit/bin/feltkit.js", "dev", "--no-frontend", "--port", "0"], {
    env: { ...env, FELTKIT_STATE_DIR: state, SITEMAP_INTEL_ALLOW_PRIVATE: "1", SITEMAP_INTEL_TICK_MS: "500", SITEMAP_INTEL_POLL_MS: "250" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  dev.stdout.on("data", (c) => (out += c));
  dev.stderr.on("data", (c) => (out += c));
  exitedRef.value = false;
  dev.once("exit", () => (exitedRef.value = true));
  try {
    const url = await until("the dev server", async () => /App\s+(http:\/\/localhost:\d+)/.exec(out)?.[1], 60_000);
    const health = await until("the capturer to be ready", async () => {
      const h = (await (await fetch(`${url}/_feltkit/health`)).json()) as { status: string };
      return h.status === "ready" && h;
    });
    assert.equal(health.status, "ready");

    const client = createClient({ url, session: "bearer" });
    await client.signInAsDevUser("ada");
    await client.mutation(api.intel.setBrand, { brand: "MyBrand" });
    const id = await client.mutation(api.intel.addCompetitor, { site: "acme.com" });
    await client.mutation(api.intel.updateCompetitor, { id, sitemapUrl });

    // Ada sets a daily schedule whose first run is two seconds from now, then does nothing else.
    await client.mutation(api.schedule.set, { competitorId: id, cadence: "daily", firstRunAt: Date.now() + 2_000 });
    await client.signOut();

    const viewer = createClient({ url, session: "bearer" });
    await viewer.signInAsDevUser("grace");
    const scheduled = await until("the scheduled capture", async () => {
      const snaps = await viewer.query(api.intel.listSnapshots, { competitorId: id });
      return snaps.find((x) => x.state === "complete");
    });
    assert.deepEqual({ trigger: scheduled.trigger, requestedBy: scheduled.requestedBy, takenBy: scheduled.takenBy, urls: scheduled.urlCount }, { trigger: "schedule", requestedBy: "ada", takenBy: "component:capturer", urls: 3 });
    const report = await viewer.query(api.intel.report, { competitorId: id });
    assert.equal(report.attacks[0]!.targetsYou, true);
    const [c] = await viewer.query(api.intel.listCompetitors);
    assert.ok(c!.schedule!.nextRunAt > Date.now() + 23 * 3_600_000, "advanced to tomorrow");

    // "Capture now" uses the same path.
    await client.signInAsDevUser("ada");
    const manual = await client.mutation(api.snapshots.request, { competitorId: id });
    const done = await until("the manual capture", async () => (await client.query(api.intel.listSnapshots, { competitorId: id })).find((x) => x.id === manual && x.state === "complete"));
    assert.equal(done.trigger, "manual");

    const status = (await (await fetch(`${url}/capturer/status`)).json()) as { done: number; lastTickError: string | null };
    assert.equal(status.done, 2);
    assert.equal(status.lastTickError, null);
  } catch (e) {
    console.log(out.slice(-4000));
    throw e;
  } finally {
    if (!exitedRef.value) {
      dev.kill("SIGTERM");
      await new Promise((r) => dev.once("exit", r));
    }
    fixture.close();
    rmSync(state, { recursive: true, force: true });
  }
});
