/**
 * Sitemap Intel: competitor intelligence from the one file every competitor has to publish.
 *
 * A competitor's sitemap is captured as a snapshot (every URL and its lastmod). Each URL is
 * classified deterministically (feltkit/_sitemap.ts): /vs/ and /alternative/ pages say whom they
 * attack, /industries/ and /solutions/ pages say which markets they go after, lastmod says what
 * changed, and the difference between two snapshots says what is new. All of it lives in this
 * app's single FeltDB instance, so history survives and every report can be re-derived.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "sitemap-intel",
  description: "Competitor intelligence from public sitemaps: who they target, what changed, which markets they enter.",
  roles: {
    // Members track competitors and take snapshots.
    member: ["intel.*", "webhooks.emit", "webhooks.deliver", "feltkit.agent.*"],
    // Viewers read reports.
    viewer: ["intel.read", "feltkit.agent.read"],
    // Agents (MCP / AppPort) read reports; they cannot add competitors or fetch anything.
    agent: ["intel.read", "feltkit.agent.*"],
    // The capturer component (gateway/capturer.ts): claims due schedules and requested captures,
    // fetches sitemaps, and writes snapshots. It acts as the application itself: no person's
    // session or API key is involved, so schedules keep running whoever is signed in.
    capturer: ["intel.read", "intel.capture"],
    // Admins configure the app in Studio → Services.
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "webhooks.*", "feltkit.operations.*"],
  },
  auth: { accounts: { roles: ["member"] } },
  components: {
    capturer: {
      entry: "gateway/capturer.ts",
      routes: ["/capturer/"],
      required: true,
      principal: { id: "component:capturer", roles: ["capturer"], displayName: "Sitemap capturer" },
      network: "egress",
      description: "Fetches competitors' sitemaps on their schedules and on request, as the application.",
    },
  },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["viewer"] },
    ],
  },
  services: {
    configuration: true,
    apiKeys: { roles: ["member"] },
    // Emitted when a snapshot completes, with how many new /vs/, /alternative/, industry and
    // solution pages appeared and whether any of them target your brand.
    webhooks: { events: ["snapshot.completed"] },
    intelligence: true,
  },
});

/** Your own brand: used to flag pages that target you and to write bid terms. One record. */
export const profile = app.collection(
  "profile",
  {
    scope: s.literal("app"),
    brand: s.string({ maxLength: 80 }),
    updatedAt: s.number(),
    updatedBy: s.string(),
  },
  { unique: [["scope"]] },
);

export const competitors = app.collection(
  "competitors",
  {
    name: s.string({ minLength: 1, maxLength: 80 }),
    domain: s.string({ minLength: 1, maxLength: 253 }),
    sitemapUrl: s.string({ minLength: 1, maxLength: 2048 }),
    createdAt: s.number(),
    createdBy: s.string(),
    /**
     * How often the capturer reads this competitor's sitemap. Set by a person (intel.write);
     * `nextRunAt` is advanced by `schedule:claimDue` in the same transaction that records the work.
     */
    schedule: s.optional(
      s.object({
        cadence: s.enum(["daily", "weekly", "monthly"]),
        anchorAt: s.number(),
        nextRunAt: s.number(),
        setBy: s.string(),
        setAt: s.number(),
        lastRequestedAt: s.optional(s.number()),
      }),
    ),
  },
  { unique: [["domain"]] },
);

/**
 * One capture of a competitor's sitemap. Pages are written in batches while `state` is
 * "collecting"; only "complete" snapshots are used by reports and diffs, so a partial capture
 * never masquerades as the competitor's site.
 */
export const snapshots = app.collection(
  "snapshots",
  {
    competitorId: s.ref("competitors"),
    source: s.enum(["fetch", "paste"]),
    /**
     * queued: requested (a person's "Capture now" or a due schedule), waiting for the capturer.
     * collecting: pages are being written. complete / failed: settled.
     */
    state: s.enum(["queued", "collecting", "complete", "failed"]),
    /** What asked for it: a person (manual), a schedule, or a paste. */
    trigger: s.optional(s.enum(["manual", "schedule", "paste"])),
    /** The person who asked, or who set the schedule that asked. */
    requestedBy: s.optional(s.string()),
    startedAt: s.number(),
    completedAt: s.optional(s.number()),
    takenBy: s.string(),
    urlCount: s.integer(),
    filesRead: s.array(s.string()),
    truncated: s.boolean(),
    problems: s.array(s.string({ maxLength: 500 })),
  },
  { indexes: [{ fields: ["competitorId"] }, { fields: ["state"] }] },
);

/**
 * LEGACY: one row per URL. New captures write `pageChunks` instead; this collection is only read
 * (until `snapshots:compactLegacy` has moved its rows into chunks). Why: FeltKit's own
 * housekeeping scans every row of the database once a second, so tens of thousands of page rows
 * kept a one-CPU machine busy while idle.
 */
export const pages = app.collection(
  "pages",
  {
    snapshotId: s.ref("snapshots"),
    competitorId: s.string(),
    url: s.string({ maxLength: 2048 }),
    lastmod: s.optional(s.string({ maxLength: 64 })),
    lastmodMs: s.optional(s.number()),
    categories: s.array(s.enum(["vs", "alternative", "industry", "solution"])),
    target: s.optional(s.string({ maxLength: 200 })),
  },
  { indexes: [{ fields: ["snapshotId"] }] },
);

const PageItem = s.object({
  url: s.string({ maxLength: 2048 }),
  lastmod: s.optional(s.string({ maxLength: 64 })),
  lastmodMs: s.optional(s.number()),
  categories: s.array(s.enum(["vs", "alternative", "industry", "solution"])),
  target: s.optional(s.string({ maxLength: 200 })),
});

/** One snapshot's pages, up to `BATCH` per row: a row per capture batch, not a row per URL. */
export const pageChunks = app.collection(
  "pageChunks",
  {
    snapshotId: s.ref("snapshots"),
    competitorId: s.string(),
    items: s.array(PageItem, { maxItems: 1000 }),
  },
  { indexes: [{ fields: ["snapshotId"] }] },
);

/**
 * What a competitor's own site says, from the capture's homepage, pricing and about fetches.
 * One record per competitor, replaced on each capture; `changes` says what differs from the
 * record it replaced.
 */
export const sites = app.collection(
  "sites",
  {
    competitorId: s.string(),
    capturedAt: s.number(),
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
    changes: s.array(s.string({ maxLength: 300 }), { maxItems: 12 }),
  },
  { unique: [["competitorId"]] },
);
