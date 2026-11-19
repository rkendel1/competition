/**
 * What the capturer does, separated from how it is hosted, so tests drive it directly:
 *
 *   tick()     ask the app which schedules are due (schedule:claimDue). That mutation queues the
 *              captures and records this component's work in one transaction.
 *   perform()  take one queued snapshot (snapshots:start), read the sitemap tree, write it
 *              (snapshots:append / finish / markFailed).
 *
 * Every write goes through the application's functions as the component's principal.
 */
import { collect, write, type FetchText } from "../feltkit/_collect.js";
import { scrapeSite } from "./scrape.js";

export type Call = <T = unknown>(name: string, args?: object) => Promise<T>;

export interface PerformResult {
  outcome: "done" | "skipped";
  snapshotId?: string;
  state?: "complete" | "failed";
  urlCount?: number;
  problems?: string[];
}

export async function tick(call: Call, now = Date.now()) {
  return call<{ queued: string[]; skipped: string[] }>("schedule:claimDue", { now });
}

export async function perform(call: Call, fetchText: FetchText, input: { snapshotId?: unknown }): Promise<PerformResult> {
  if (typeof input.snapshotId !== "string") return { outcome: "skipped" };
  const started = await call<{ snapshotId: string; competitorId: string; sitemapUrl: string; domain?: string } | null>("snapshots:start", { snapshotId: input.snapshotId });
  if (!started) return { outcome: "skipped", snapshotId: input.snapshotId };
  const got = await collect({ url: started.sitemapUrl }, fetchText);
  const result = await write(started.snapshotId, got, {
    append: (snapshotId, pages) => call("snapshots:append", { snapshotId, pages }),
    finish: (snapshotId, meta) => call("snapshots:finish", { snapshotId, ...meta }),
    markFailed: (snapshotId, meta) => call("snapshots:markFailed", { snapshotId, ...meta }),
  });
  // The competitor's own pages: best effort, and never a reason to fail a sitemap capture.
  if (result.state === "complete" && started.domain) {
    try {
      const { site } = await scrapeSite(started.domain, fetchText);
      if (site) await call("snapshots:recordSite", { competitorId: started.competitorId, site });
    } catch {
      /* the sitemap snapshot stands without it */
    }
  }
  return { outcome: "done", snapshotId: started.snapshotId, state: result.state, urlCount: result.urlCount, problems: result.problems };
}
