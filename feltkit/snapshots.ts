/**
 * The snapshot lifecycle:
 *
 *   queued ──start──▶ collecting ──append…──▶ finish ──▶ complete
 *      │                   └────────── markFailed ──▶ failed
 *      └─ (delete: cancel)
 *
 * `request` (a person's "Capture now") and `schedule:claimDue` (a due schedule) create a queued
 * snapshot and, in the same transaction, record durable work for the capturer component
 * (`ctx.afterCommit.work`). Nothing is queued unless that commit happens, and the work survives
 * restarts. The component then calls `start`, `append` and `finish` as its own principal.
 * Pasted XML skips the queue: `begin` creates a collecting snapshot for the person pasting.
 * Reports only read complete snapshots.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { app, competitors, pages, profile, sites, snapshots } from "./app.js";
import { siteChanges } from "./_site.js";
import { classify, diffUrls, lastmodMs, targetOf, targetsBrand } from "./_sitemap.js";
import { BATCH, MAX_FILES } from "./_limits.js";
import { enqueueCapture, inFlight } from "./_capture.js";

const PageInput = s.object({
  url: s.string({ maxLength: 2048 }),
  lastmod: s.optional(s.string({ maxLength: 64 })),
});

/** "Capture now": queue a capture of this competitor's sitemap for the capturer. */
export const request = app.mutation({
  access: "intel.write",
  args: { competitorId: s.string() },
  returns: s.string(),
  capability: { name: "intel.capturenow", description: "Queue a capture of a competitor's sitemap now. The app's capturer fetches it; no API key is needed." },
  handler: async (ctx, { competitorId }) => {
    if (!(await ctx.db.get(competitors, competitorId))) fail("NOT_FOUND", "No such competitor.");
    const busy = await inFlight(ctx, competitorId);
    if (busy) fail("FAILED_PRECONDITION", `A capture is already ${busy.state} for this competitor.`);
    return enqueueCapture(ctx, competitorId, "manual", ctx.auth.requirePrincipal().id);
  },
});

const Started = s.object({ snapshotId: s.string(), competitorId: s.string(), sitemapUrl: s.string(), domain: s.string() });

/**
 * The capturer takes a queued snapshot. If the snapshot is already collecting, an earlier attempt
 * was interrupted (the component's lease expired): that attempt is marked failed and a fresh
 * snapshot is started, so a half-written capture never becomes complete. Returns null when the
 * snapshot was cancelled or is already settled.
 */
export const start = app.mutation({
  access: "intel.capture",
  args: { snapshotId: s.string() },
  returns: s.nullable(Started),
  handler: async (ctx, { snapshotId }) => {
    const snap = await ctx.db.get(snapshots, snapshotId);
    if (!snap || snap.state === "complete" || snap.state === "failed") return null;
    const competitor = await ctx.db.get(competitors, snap.competitorId);
    if (!competitor) return null;
    const me = ctx.auth.requirePrincipal().id;
    if (snap.state === "queued") {
      await ctx.db.patch(snapshots, snapshotId, { state: "collecting", takenBy: me, startedAt: Date.now() });
      return { snapshotId, competitorId: competitor.id, sitemapUrl: competitor.sitemapUrl, domain: competitor.domain };
    }
    await ctx.db.patch(snapshots, snapshotId, { state: "failed", completedAt: Date.now(), problems: [...snap.problems, "Interrupted before it finished; restarted as a new snapshot."].slice(-20) });
    const fresh = await ctx.db.insert(snapshots, {
      competitorId: snap.competitorId,
      source: "fetch",
      state: "collecting",
      ...(snap.trigger ? { trigger: snap.trigger } : {}),
      ...(snap.requestedBy ? { requestedBy: snap.requestedBy } : {}),
      startedAt: Date.now(),
      takenBy: me,
      urlCount: 0,
      filesRead: [],
      truncated: false,
      problems: [],
    });
    return { snapshotId: fresh, competitorId: competitor.id, sitemapUrl: competitor.sitemapUrl, domain: competitor.domain };
  },
});

/** Pasted XML: a collecting snapshot owned by the person pasting. */
export const begin = app.mutation({
  access: "intel.capture",
  args: { competitorId: s.string() },
  returns: s.string(),
  handler: async (ctx, { competitorId }) => {
    if (!(await ctx.db.get(competitors, competitorId))) fail("NOT_FOUND", "No such competitor.");
    const me = ctx.auth.requirePrincipal().id;
    return ctx.db.insert(snapshots, {
      competitorId,
      source: "paste",
      state: "collecting",
      trigger: "paste",
      requestedBy: me,
      startedAt: Date.now(),
      takenBy: me,
      urlCount: 0,
      filesRead: [],
      truncated: false,
      problems: [],
    });
  },
});

async function collecting(ctx: MutationCtx, snapshotId: string) {
  const snap = await ctx.db.get(snapshots, snapshotId);
  if (!snap) fail("NOT_FOUND", "No such snapshot.");
  if (snap.state !== "collecting") fail("FAILED_PRECONDITION", `This snapshot is ${snap.state}.`);
  if (snap.takenBy !== ctx.auth.requirePrincipal().id) fail("FORBIDDEN", "Only the principal taking a snapshot can add to it.");
  return snap;
}

export const append = app.mutation({
  access: "intel.capture",
  args: { snapshotId: s.string(), pages: s.array(PageInput, { maxItems: BATCH }) },
  handler: async (ctx, { snapshotId, pages: batch }) => {
    const snap = await collecting(ctx, snapshotId);
    const competitor = await ctx.db.get(competitors, snap.competitorId);
    const own = competitor?.name ?? competitor?.domain ?? "";
    for (const page of batch) {
      const ms = lastmodMs(page.lastmod);
      const target = targetOf(page.url, own) ?? targetOf(page.url, competitor?.domain ?? "");
      const categories = classify(page.url);
      await ctx.db.insert(pages, {
        snapshotId,
        competitorId: snap.competitorId,
        url: page.url,
        ...(page.lastmod ? { lastmod: page.lastmod } : {}),
        ...(ms !== undefined ? { lastmodMs: ms } : {}),
        categories,
        ...(target && (categories.includes("vs") || categories.includes("alternative")) ? { target } : {}),
      });
    }
    await ctx.db.patch(snapshots, snapshotId, { urlCount: snap.urlCount + batch.length });
  },
});

export const finish = app.mutation({
  access: "intel.capture",
  args: { snapshotId: s.string(), filesRead: s.array(s.string()), truncated: s.boolean(), problems: s.array(s.string()) },
  returns: s.object({ newSignals: s.integer(), newTargetingYou: s.integer() }),
  handler: async (ctx, { snapshotId, filesRead, truncated, problems }) => {
    const snap = await collecting(ctx, snapshotId);
    const previous = (await ctx.db.find(snapshots, { competitorId: snap.competitorId }))
      .filter((x) => x.state === "complete")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
    const current = await ctx.db.find(pages, { snapshotId });
    let newSignals = 0;
    let newTargetingYou = 0;
    if (previous) {
      const prevUrls = (await ctx.db.find(pages, { snapshotId: previous.id })).map((x) => x.url);
      const added = new Set(diffUrls(prevUrls, current.map((x) => x.url)).added);
      const [p] = await ctx.db.find(profile, { scope: "app" });
      for (const x of current) {
        if (!added.has(x.url) || !x.categories.length) continue;
        newSignals++;
        if (targetsBrand(x.target, p?.brand ?? "")) newTargetingYou++;
      }
    }
    await ctx.db.patch(snapshots, snapshotId, {
      state: "complete",
      completedAt: Date.now(),
      urlCount: current.length,
      filesRead: filesRead.slice(0, MAX_FILES + 1),
      truncated,
      problems: problems.slice(0, 20).map((x) => x.slice(0, 500)),
    });
    ctx.afterCommit.webhooks.emit("snapshot.completed", {
      snapshotId,
      competitorId: snap.competitorId,
      trigger: snap.trigger ?? "manual",
      urls: current.length,
      comparedWithPrevious: Boolean(previous),
      newSignals,
      newTargetingYou,
    });
    return { newSignals, newTargetingYou };
  },
});

export const markFailed = app.mutation({
  access: "intel.capture",
  args: { snapshotId: s.string(), problems: s.array(s.string()), filesRead: s.array(s.string()) },
  handler: async (ctx, { snapshotId, problems, filesRead }) => {
    await collecting(ctx, snapshotId);
    await ctx.db.patch(snapshots, snapshotId, {
      state: "failed",
      completedAt: Date.now(),
      filesRead: filesRead.slice(0, MAX_FILES + 1),
      problems: problems.slice(0, 20).map((x) => x.slice(0, 500)),
    });
  },
});

const SiteInput = s.object({
  homepage: s.object({
    url: s.string({ maxLength: 2048 }),
    title: s.optional(s.string({ maxLength: 200 })),
    description: s.optional(s.string({ maxLength: 400 })),
    headline: s.optional(s.string({ maxLength: 200 })),
  }),
  pricing: s.optional(
    s.object({
      url: s.string({ maxLength: 2048 }),
      free: s.boolean(),
      trial: s.boolean(),
      contactSales: s.boolean(),
      prices: s.array(s.string({ maxLength: 20 }), { maxItems: 8 }),
      plans: s.array(s.string({ maxLength: 30 }), { maxItems: 6 }),
    }),
  ),
  about: s.optional(s.object({ url: s.string({ maxLength: 2048 }), summary: s.optional(s.string({ maxLength: 400 })) })),
});

/** The capturer records what the competitor's own pages say; the record replaces the last one. */
export const recordSite = app.mutation({
  access: "intel.capture",
  args: { competitorId: s.string(), site: SiteInput },
  handler: async (ctx, { competitorId, site }) => {
    if (!(await ctx.db.get(competitors, competitorId))) return;
    const [prev] = await ctx.db.find(sites, { competitorId });
    const changes = siteChanges(prev, site).slice(0, 12);
    const value = { competitorId, capturedAt: Date.now(), ...site, changes };
    if (prev) await ctx.db.replace(sites, prev.id, value);
    else await ctx.db.insert(sites, value);
  },
});
