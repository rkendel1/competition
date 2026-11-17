/**
 * Snapshot records and the mutations `capture:run` writes through. Each is one atomic commit;
 * only the person who began a snapshot may add to or finish it.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { app, competitors, pages, profile, snapshots } from "./app.js";
import { classify, diffUrls, lastmodMs, targetOf, targetsBrand } from "./_sitemap.js";
import { BATCH, MAX_FILES } from "./_limits.js";

const PageInput = s.object({
  url: s.string({ maxLength: 2048 }),
  lastmod: s.optional(s.string({ maxLength: 64 })),
});

export const competitorForCapture = app.query({
  access: "intel.write",
  args: { competitorId: s.string() },
  returns: s.object({ sitemapUrl: s.string(), domain: s.string() }),
  handler: async (ctx, { competitorId }) => {
    const c = await ctx.db.get(competitors, competitorId);
    if (!c) fail("NOT_FOUND", "No such competitor.");
    return { sitemapUrl: c.sitemapUrl, domain: c.domain };
  },
});

export const begin = app.mutation({
  access: "intel.write",
  args: { competitorId: s.string(), source: s.enum(["fetch", "paste"]) },
  returns: s.string(),
  handler: async (ctx, { competitorId, source }) => {
    if (!(await ctx.db.get(competitors, competitorId))) fail("NOT_FOUND", "No such competitor.");
    return ctx.db.insert(snapshots, {
      competitorId,
      source,
      state: "collecting",
      startedAt: Date.now(),
      takenBy: ctx.auth.requirePrincipal().id,
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
  if (snap.takenBy !== ctx.auth.requirePrincipal().id) fail("FORBIDDEN", "Only the person taking a snapshot can add to it.");
  return snap;
}

export const append = app.mutation({
  access: "intel.write",
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
  access: "intel.write",
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
      urls: current.length,
      comparedWithPrevious: Boolean(previous),
      newSignals,
      newTargetingYou,
    });
    return { newSignals, newTargetingYou };
  },
});

export const markFailed = app.mutation({
  access: "intel.write",
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

