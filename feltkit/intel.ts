/**
 * Competitors, your brand, and the report: who they target, what changed, which markets.
 * Every number in the report is derived from stored, complete snapshots.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, competitors, pages, profile, snapshots } from "./app.js";
import { bidTerms, defaultSitemapUrl, diffUrls, domainOf, targetsBrand, type Category } from "./_sitemap.js";

// ---------- your brand ----------

export const getProfile = app.query({
  access: "public",
  returns: s.object({ brand: s.string() }),
  capability: { name: "intel.profile", description: "Your own brand name, used to flag competitor pages that target you." },
  handler: async (ctx) => {
    const [p] = await ctx.db.find(profile, { scope: "app" });
    return { brand: p?.brand ?? "" };
  },
});

export const setBrand = app.mutation({
  access: "intel.write",
  args: { brand: s.string({ maxLength: 80 }) },
  handler: async (ctx, { brand }) => {
    const value = { scope: "app" as const, brand: brand.trim(), updatedAt: Date.now(), updatedBy: ctx.auth.requirePrincipal().id };
    const [p] = await ctx.db.find(profile, { scope: "app" });
    if (p) await ctx.db.replace(profile, p.id, value);
    else await ctx.db.insert(profile, value);
  },
});

// ---------- competitors ----------

const CompetitorRow = s.object({
  id: s.string(),
  name: s.string(),
  domain: s.string(),
  sitemapUrl: s.string(),
  lastSnapshotAt: s.optional(s.number()),
  lastUrlCount: s.optional(s.integer()),
  snapshotCount: s.integer(),
  /** A capture that is queued or running now. */
  capturing: s.optional(s.enum(["queued", "collecting"])),
  schedule: s.optional(s.object({ cadence: s.string(), anchorAt: s.number(), nextRunAt: s.number(), setBy: s.string(), lastRequestedAt: s.optional(s.number()) })),
});

export const listCompetitors = app.query({
  access: "public",
  returns: s.array(CompetitorRow),
  capability: { name: "intel.competitors", description: "Tracked competitors with when their sitemap was last captured." },
  handler: async (ctx) => {
    const [all, snaps] = await Promise.all([ctx.db.find(competitors, {}, { orderBy: [{ field: "createdAt", direction: "asc" }] }), ctx.db.find(snapshots)]);
    return all.map((c) => {
      const theirs = snaps.filter((x) => x.competitorId === c.id);
      const mine = theirs.filter((x) => x.state === "complete").sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      const last = mine[0];
      const busy = theirs.find((x) => x.state === "queued" || x.state === "collecting");
      const sch = c.schedule;
      return {
        id: c.id,
        name: c.name,
        domain: c.domain,
        sitemapUrl: c.sitemapUrl,
        ...(last ? { lastSnapshotAt: last.completedAt, lastUrlCount: last.urlCount } : {}),
        snapshotCount: mine.length,
        ...(busy ? { capturing: busy.state as "queued" | "collecting" } : {}),
        ...(sch
          ? { schedule: { cadence: sch.cadence, anchorAt: sch.anchorAt, nextRunAt: sch.nextRunAt, setBy: sch.setBy, ...(sch.lastRequestedAt ? { lastRequestedAt: sch.lastRequestedAt } : {}) } }
          : {}),
      };
    });
  },
});

export const addCompetitor = app.mutation({
  access: "intel.write",
  args: { site: s.string({ minLength: 1, maxLength: 2048 }), name: s.optional(s.string({ maxLength: 80 })) },
  returns: s.string(),
  capability: { name: "intel.addcompetitor", description: "Track a competitor by domain or sitemap URL." },
  handler: async (ctx, { site, name }) => {
    let domain: string, sitemapUrl: string;
    try {
      domain = domainOf(site);
      sitemapUrl = defaultSitemapUrl(site);
    } catch {
      fail("INVALID_ARGUMENT", `"${site}" is not a domain or URL.`);
    }
    if (!domain.includes(".")) fail("INVALID_ARGUMENT", `"${site}" is not a public domain.`);
    if ((await ctx.db.find(competitors, { domain })).length) fail("CONFLICT", `${domain} is already tracked.`);
    const label = name?.trim() || domain.split(".")[0]!.replace(/^./, (c) => c.toUpperCase());
    return ctx.db.insert(competitors, { name: label, domain, sitemapUrl, createdAt: Date.now(), createdBy: ctx.auth.requirePrincipal().id });
  },
});

export const updateCompetitor = app.mutation({
  access: "intel.write",
  args: { id: s.string(), name: s.optional(s.string({ minLength: 1, maxLength: 80 })), sitemapUrl: s.optional(s.string({ minLength: 1, maxLength: 2048 })) },
  handler: async (ctx, { id, name, sitemapUrl }) => {
    const c = await ctx.db.get(competitors, id);
    if (!c) fail("NOT_FOUND", "No such competitor.");
    const patch: { name?: string; sitemapUrl?: string } = {};
    if (name) patch.name = name.trim();
    if (sitemapUrl) {
      try {
        patch.sitemapUrl = new URL(sitemapUrl.trim()).toString();
      } catch {
        fail("INVALID_ARGUMENT", `"${sitemapUrl}" is not a URL.`);
      }
    }
    await ctx.db.patch(competitors, id, patch);
  },
});

/**
 * Deletes one snapshot's pages, a bounded batch at a time, then the snapshot itself. Returns how
 * many pages remain, so a caller repeats until 0. Each call is one atomic commit.
 */
export const deleteSnapshot = app.mutation({
  access: "intel.write",
  args: { id: s.string() },
  returns: s.object({ remaining: s.integer() }),
  handler: async (ctx, { id }) => {
    const snap = await ctx.db.get(snapshots, id);
    if (!snap) return { remaining: 0 };
    // A queued capture can be cancelled (the capturer then skips it); a running one cannot.
    if (snap.state === "collecting" && Date.now() - snap.startedAt < 30 * 60_000) fail("FAILED_PRECONDITION", "This capture is running. Delete it once it finishes.");
    // Counted before deleting: inside the transaction, count() already reflects pending deletes.
    const total = await ctx.db.count(pages, { snapshotId: id });
    const batch = await ctx.db.find(pages, { snapshotId: id }, { limit: DELETE_BATCH });
    for (const p of batch) await ctx.db.delete(pages, p.id);
    const left = total - batch.length;
    if (left <= 0) await ctx.db.delete(snapshots, id);
    return { remaining: Math.max(0, left) };
  },
});

const DELETE_BATCH = 2000;

/** Removes a competitor once its snapshots are gone (use deleteSnapshot first). */
export const removeCompetitor = app.mutation({
  access: "intel.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    if ((await ctx.db.count(snapshots, { competitorId: id })) > 0) fail("FAILED_PRECONDITION", "Delete this competitor's snapshots first.");
    await ctx.db.delete(competitors, id);
  },
});

export const listSnapshots = app.query({
  access: "public",
  args: { competitorId: s.string() },
  returns: s.array(s.doc(snapshots)),
  handler: async (ctx, { competitorId }) =>
    (await ctx.db.find(snapshots, { competitorId })).sort((a, b) => b.startedAt - a.startedAt),
});

// ---------- the report ----------

const PageRow = s.object({
  url: s.string(),
  path: s.string(),
  lastmod: s.optional(s.string()),
  lastmodMs: s.optional(s.number()),
  categories: s.array(s.string()),
  target: s.optional(s.string()),
  targetsYou: s.boolean(),
  isNew: s.boolean(),
});

const Report = s.object({
  competitor: s.object({ id: s.string(), name: s.string(), domain: s.string(), sitemapUrl: s.string() }),
  brand: s.string(),
  snapshot: s.optional(s.doc(snapshots)),
  previous: s.optional(s.object({ id: s.string(), completedAt: s.optional(s.number()), urlCount: s.integer() })),
  totals: s.object({
    urls: s.integer(),
    withLastmod: s.integer(),
    vs: s.integer(),
    alternative: s.integer(),
    industry: s.integer(),
    solution: s.integer(),
    changedInWindow: s.integer(),
    added: s.integer(),
    removed: s.integer(),
  }),
  windowDays: s.integer(),
  /** Every /vs/ and /alternative/ page: whom they attack. */
  attacks: s.array(PageRow),
  /** Distinct targets, most pages first. */
  targets: s.array(s.object({ name: s.string(), pages: s.integer(), targetsYou: s.boolean(), newest: s.optional(s.string()) })),
  /** Every /industries/ and /solutions/ page: which markets they go after. */
  markets: s.array(PageRow),
  /** Pages whose lastmod is inside the window, newest first (at most 200). */
  recent: s.array(PageRow),
  /** URLs in this snapshot that were not in the previous one (at most 200). */
  added: s.array(PageRow),
  removed: s.array(s.string()),
  /** Search terms to bid on: you vs them, them vs you, them alternative(s). Empty until your brand is set. */
  bidTerms: s.array(s.string()),
});

const LIST_CAP = 200;
const DAY = 86_400_000;

export const report = app.query({
  access: "public",
  args: { competitorId: s.string(), windowDays: s.optional(s.integer({ minimum: 1, maximum: 365 })), now: s.optional(s.number()) },
  returns: Report,
  capability: {
    name: "intel.report",
    description:
      "A competitor's sitemap report from its latest complete snapshot: /vs/ and /alternative/ pages (whom they attack, flagging pages aimed at your brand), /industries/ and /solutions/ pages (markets), pages changed within the window by lastmod, pages added or removed since the previous snapshot, and search terms to bid on.",
  },
  handler: async (ctx, { competitorId, windowDays = 30, now }) => {
    const c = await ctx.db.get(competitors, competitorId);
    if (!c) fail("NOT_FOUND", "No such competitor.");
    const [p] = await ctx.db.find(profile, { scope: "app" });
    const brand = p?.brand ?? "";
    const done = (await ctx.db.find(snapshots, { competitorId }))
      .filter((x) => x.state === "complete")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    const [latest, previous] = done;
    const competitor = { id: c.id, name: c.name, domain: c.domain, sitemapUrl: c.sitemapUrl };
    const empty = { urls: 0, withLastmod: 0, vs: 0, alternative: 0, industry: 0, solution: 0, changedInWindow: 0, added: 0, removed: 0 };
    if (!latest) {
      return { competitor, brand, totals: empty, windowDays, attacks: [], targets: [], markets: [], recent: [], added: [], removed: [], bidTerms: bidTerms(brand, c.name) };
    }

    const current = await ctx.db.find(pages, { snapshotId: latest.id });
    const prevUrls = previous ? (await ctx.db.find(pages, { snapshotId: previous.id })).map((x) => x.url) : null;
    const diff = prevUrls ? diffUrls(prevUrls, current.map((x) => x.url)) : { added: [], removed: [] };
    const addedSet = new Set(diff.added);

    const row = (x: (typeof current)[number]) => ({
      url: x.url,
      path: safePath(x.url),
      ...(x.lastmod !== undefined ? { lastmod: x.lastmod } : {}),
      ...(x.lastmodMs !== undefined ? { lastmodMs: x.lastmodMs } : {}),
      categories: x.categories,
      ...(x.target !== undefined ? { target: x.target } : {}),
      targetsYou: targetsBrand(x.target, brand),
      isNew: addedSet.has(x.url),
    });
    const byNewest = (a: { lastmodMs?: number; url: string }, b: { lastmodMs?: number; url: string }) =>
      (b.lastmodMs ?? -Infinity) - (a.lastmodMs ?? -Infinity) || cmp(a.url, b.url);
    const has = (cat: Category) => (x: (typeof current)[number]) => x.categories.includes(cat);

    const attacksRaw = current.filter((x) => has("vs")(x) || has("alternative")(x));
    const attacks = attacksRaw.map(row).sort((a, b) => Number(b.targetsYou) - Number(a.targetsYou) || byNewest(a, b));
    const markets = current.filter((x) => has("industry")(x) || has("solution")(x)).map(row).sort(byNewest);

    const tally = new Map<string, { name: string; pages: number; targetsYou: boolean; newestMs: number; newest?: string }>();
    for (const x of attacksRaw) {
      if (!x.target) continue;
      const key = x.target.toLowerCase();
      const t = tally.get(key) ?? { name: x.target, pages: 0, targetsYou: targetsBrand(x.target, brand), newestMs: -Infinity };
      t.pages++;
      if ((x.lastmodMs ?? -Infinity) > t.newestMs) {
        t.newestMs = x.lastmodMs ?? -Infinity;
        t.newest = x.lastmod;
      }
      tally.set(key, t);
    }
    const targets = [...tally.values()]
      .sort((a, b) => Number(b.targetsYou) - Number(a.targetsYou) || b.pages - a.pages || cmp(a.name, b.name))
      .map(({ name, pages: n, targetsYou, newest }) => ({ name, pages: n, targetsYou, ...(newest ? { newest } : {}) }));

    const reference = now ?? latest.completedAt ?? latest.startedAt;
    const since = reference - windowDays * DAY;
    const inWindow = current.filter((x) => x.lastmodMs !== undefined && x.lastmodMs >= since && x.lastmodMs <= reference + DAY);

    return {
      competitor,
      brand,
      snapshot: latest,
      ...(previous ? { previous: { id: previous.id, ...(previous.completedAt ? { completedAt: previous.completedAt } : {}), urlCount: previous.urlCount } } : {}),
      totals: {
        urls: current.length,
        withLastmod: current.filter((x) => x.lastmodMs !== undefined).length,
        vs: current.filter(has("vs")).length,
        alternative: current.filter(has("alternative")).length,
        industry: current.filter(has("industry")).length,
        solution: current.filter(has("solution")).length,
        changedInWindow: inWindow.length,
        added: diff.added.length,
        removed: diff.removed.length,
      },
      windowDays,
      attacks,
      targets,
      markets,
      recent: inWindow.map(row).sort(byNewest).slice(0, LIST_CAP),
      added: current.filter((x) => addedSet.has(x.url)).map(row).sort(byNewest).slice(0, LIST_CAP),
      removed: diff.removed.slice(0, LIST_CAP),
      bidTerms: bidTerms(brand, c.name),
    };
  },
});

/** Locale-independent ordering, so reports sort the same everywhere. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
