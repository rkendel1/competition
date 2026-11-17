/**
 * Capturing a competitor's sitemap: `capture:run`.
 *
 * An action (not a transaction): it reads the sitemap over HTTP, or from XML a person pasted,
 * follows sitemap indexes, and writes what it found through the mutations in snapshots.ts. A
 * snapshot is "collecting" until `snapshots:finish` commits it as "complete"; on any failure it
 * is marked "failed" with the reason. Reports only read complete snapshots.
 *
 * The network is only touched here, never from a query or mutation.
 */
import { lookup } from "node:dns/promises";
import { s } from "@feltdb/feltkit";
import { api } from "./_generated/api.js";
import { app } from "./app.js";
import { checkFetchableUrl, isPrivateHost, parseSitemap, type SitemapEntry } from "./_sitemap.js";
import { BATCH, MAX_FILES } from "./_limits.js";

const MAX_URLS = 50_000;
const MAX_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "sitemap-intel/0.1 (competitive research; reads public sitemaps)";

/** Development and tests may read local fixtures; production never reads private networks. */
const allowPrivate = () => process.env.SITEMAP_INTEL_ALLOW_PRIVATE === "1";

export const run = app.action({
  access: "intel.write",
  args: {
    competitorId: s.string(),
    /** Sitemap XML a person pasted (a urlset or an index). Without it, the sitemap is fetched. */
    xml: s.optional(s.string({ maxLength: 20_000_000 })),
  },
  handler: async (ctx, { competitorId, xml }) => {
    const competitor = await ctx.runQuery(api.snapshots.competitorForCapture, { competitorId });
    const snapshotId = await ctx.runMutation(api.snapshots.begin, { competitorId, source: xml ? "paste" : "fetch" });
    const problems: string[] = [];
    const filesRead: string[] = [];
    try {
      const entries = new Map<string, SitemapEntry>();
      let truncated = false;
      const queue: string[] = [];
      const seen = new Set<string>();

      const absorb = (label: string, body: string) => {
        const parsed = parseSitemap(body);
        if (parsed.kind === "unknown") {
          problems.push(`${label}: not a sitemap (no <urlset> or <sitemapindex>).`);
          return;
        }
        filesRead.push(label);
        if (parsed.kind === "index") {
          for (const e of parsed.entries) if (!seen.has(e.loc)) queue.push(e.loc);
          return;
        }
        for (const e of parsed.entries) {
          if (entries.size >= MAX_URLS) {
            truncated = true;
            break;
          }
          if (!entries.has(e.loc)) entries.set(e.loc, e);
        }
      };

      if (xml) {
        absorb("pasted XML", xml);
      } else {
        const root = await fetchSitemapOrRobots(competitor.sitemapUrl, ctx.signal);
        seen.add(root.url);
        problems.push(...root.problems);
        if (root.body) absorb(root.url, root.body);
        queue.push(...root.extra.filter((u) => !seen.has(u)));
      }

      ctx.emit({ type: "progress", stage: "reading", files: filesRead.length, urls: entries.size, queued: queue.length });
      while (queue.length && !truncated) {
        if (seen.size >= MAX_FILES) {
          truncated = true;
          problems.push(`Stopped after ${MAX_FILES} sitemap files; ${queue.length} more were listed.`);
          break;
        }
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        try {
          absorb(next, await fetchText(next, ctx.signal));
        } catch (e) {
          problems.push(`${next}: ${(e as Error).message}`);
        }
        ctx.emit({ type: "progress", stage: "reading", files: filesRead.length, urls: entries.size, queued: queue.length });
      }
      if (truncated && entries.size >= MAX_URLS) problems.push(`Kept the first ${MAX_URLS} URLs.`);
      if (!entries.size) {
        await ctx.runMutation(api.snapshots.markFailed, { snapshotId, problems: problems.length ? problems : ["The sitemap listed no URLs."], filesRead });
        return { snapshotId, state: "failed" as const, urlCount: 0, problems };
      }

      const all = [...entries.values()];
      for (let i = 0; i < all.length; i += BATCH) {
        const batch = all.slice(i, i + BATCH).map((e) => (e.lastmod ? { url: e.loc, lastmod: e.lastmod.slice(0, 64) } : { url: e.loc }));
        await ctx.runMutation(api.snapshots.append, { snapshotId, pages: batch });
        ctx.emit({ type: "progress", stage: "saving", saved: Math.min(i + BATCH, all.length), urls: all.length });
      }
      const result = await ctx.runMutation(api.snapshots.finish, { snapshotId, filesRead, truncated, problems });
      return { snapshotId, state: "complete" as const, urlCount: all.length, problems, ...result };
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      await ctx.runMutation(api.snapshots.markFailed, { snapshotId, problems: [...problems, message].slice(-20), filesRead }).catch(() => undefined);
      return { snapshotId, state: "failed" as const, urlCount: 0, problems: [...problems, message] };
    }
  },
});

// ---------- HTTP ----------

/** Reads the configured sitemap; if that fails, looks for `Sitemap:` lines in robots.txt. */
async function fetchSitemapOrRobots(sitemapUrl: string, signal: AbortSignal): Promise<{ url: string; body?: string; extra: string[]; problems: string[] }> {
  try {
    return { url: sitemapUrl, body: await fetchText(sitemapUrl, signal), extra: [], problems: [] };
  } catch (first) {
    const problems = [`${sitemapUrl}: ${(first as Error).message}`];
    const robots = new URL("/robots.txt", sitemapUrl).toString();
    try {
      const text = await fetchText(robots, signal, true);
      const listed = [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
      if (!listed.length) throw new Error("robots.txt lists no sitemaps");
      problems.push(`Used the sitemaps listed in robots.txt instead.`);
      return { url: robots, extra: listed, problems };
    } catch (e) {
      problems.push(`${robots}: ${(e as Error).message}`);
      throw new Error(problems.join(" "));
    }
  }
}

async function assertPublic(url: URL) {
  checkFetchableUrl(url.toString(), allowPrivate());
  if (allowPrivate()) return;
  const addrs = await lookup(url.hostname, { all: true }).catch(() => {
    throw new Error(`${url.hostname} does not resolve.`);
  });
  if (addrs.some((a) => isPrivateHost(a.address))) throw new Error(`${url.hostname} resolves to a private address.`);
}

/** GET with redirects checked hop by hop, a timeout, a size cap, and gzip support. */
async function fetchText(raw: string, signal: AbortSignal, plain = false): Promise<string> {
  let url = new URL(raw);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: { "user-agent": USER_AGENT, accept: plain ? "text/plain,*/*" : "application/xml,text/xml,*/*" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await readCapped(res);
    const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const data = gz ? await gunzip(bytes) : bytes;
    return new TextDecoder("utf-8").decode(data);
  }
  throw new Error("Too many redirects.");
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`larger than ${MAX_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.byteLength));
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
