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
    // Admins configure the app in Studio → Services.
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "webhooks.*", "feltkit.operations.*"],
  },
  auth: { accounts: { roles: ["member"] } },
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
    state: s.enum(["collecting", "complete", "failed"]),
    startedAt: s.number(),
    completedAt: s.optional(s.number()),
    takenBy: s.string(),
    urlCount: s.integer(),
    filesRead: s.array(s.string()),
    truncated: s.boolean(),
    problems: s.array(s.string({ maxLength: 500 })),
  },
  { indexes: [{ fields: ["competitorId"] }] },
);

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
