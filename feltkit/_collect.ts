/**
 * Reading a sitemap tree and writing it as a snapshot, independent of where it runs. The network
 * is passed in (`fetchText`), so this one routine serves the capturer component (real HTTP) and a
 * person's pasted XML (no network at all), and tests can drive it with fixtures.
 */
import { parseSitemap, type SitemapEntry } from "./_sitemap.js";
import { BATCH, MAX_FILES } from "./_limits.js";

export const MAX_URLS = 50_000;

export type FetchText = (url: string) => Promise<string>;

export interface Collected {
  entries: SitemapEntry[];
  filesRead: string[];
  problems: string[];
  truncated: boolean;
}

export type Progress = (p: { stage: "reading" | "saving"; files?: number; urls?: number; saved?: number }) => void;

/**
 * Reads a sitemap and everything a sitemap index points to, breadth first, up to MAX_FILES files
 * and MAX_URLS URLs. `root` is either a URL to fetch (with a robots.txt fallback) or a document a
 * person pasted. Never throws for one bad file: problems are collected and reported.
 */
export async function collect(root: { url: string } | { pasted: string }, fetchText: FetchText | null, progress?: Progress): Promise<Collected> {
  const entries = new Map<string, SitemapEntry>();
  const filesRead: string[] = [];
  const problems: string[] = [];
  const queue: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

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

  if ("pasted" in root) {
    absorb("pasted XML", root.pasted);
  } else if (fetchText) {
    seen.add(root.url);
    try {
      absorb(root.url, await fetchText(root.url));
    } catch (first) {
      problems.push(`${root.url}: ${(first as Error).message}`);
      const robots = new URL("/robots.txt", root.url).toString();
      try {
        const listed = [...(await fetchText(robots)).matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
        if (!listed.length) problems.push(`${robots}: lists no sitemaps.`);
        else problems.push("Used the sitemaps listed in robots.txt instead.");
        queue.push(...listed);
      } catch (e) {
        problems.push(`${robots}: ${(e as Error).message}`);
      }
    }
  }

  if (queue.length && !fetchText) {
    problems.push(`This is a sitemap index listing ${queue.length} sitemap(s). Use Capture now to follow them, or paste each one.`);
    queue.length = 0;
  }

  progress?.({ stage: "reading", files: filesRead.length, urls: entries.size });
  while (queue.length && !truncated && fetchText) {
    if (seen.size >= MAX_FILES) {
      truncated = true;
      problems.push(`Stopped after ${MAX_FILES} sitemap files; ${queue.length} more were listed.`);
      break;
    }
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      absorb(next, await fetchText(next));
    } catch (e) {
      problems.push(`${next}: ${(e as Error).message}`);
    }
    progress?.({ stage: "reading", files: filesRead.length, urls: entries.size });
  }
  if (truncated && entries.size >= MAX_URLS) problems.push(`Kept the first ${MAX_URLS} URLs.`);
  return { entries: [...entries.values()], filesRead, problems, truncated };
}

/** The snapshot mutations, called as whoever is capturing (the component, or the person pasting). */
export interface SnapshotWriter {
  append(snapshotId: string, pages: Array<{ url: string; lastmod?: string }>): Promise<unknown>;
  finish(snapshotId: string, meta: { filesRead: string[]; truncated: boolean; problems: string[] }): Promise<{ newSignals: number; newTargetingYou: number }>;
  markFailed(snapshotId: string, meta: { filesRead: string[]; problems: string[] }): Promise<unknown>;
}

export interface Written {
  state: "complete" | "failed";
  urlCount: number;
  problems: string[];
  newSignals?: number;
  newTargetingYou?: number;
}

/** Writes what was collected in batches and settles the snapshot as complete or failed. */
export async function write(snapshotId: string, got: Collected, writer: SnapshotWriter, progress?: Progress): Promise<Written> {
  if (!got.entries.length) {
    const problems = got.problems.length ? got.problems : ["The sitemap listed no URLs."];
    await writer.markFailed(snapshotId, { filesRead: got.filesRead, problems });
    return { state: "failed", urlCount: 0, problems };
  }
  try {
    for (let i = 0; i < got.entries.length; i += BATCH) {
      const batch = got.entries.slice(i, i + BATCH).map((e) => (e.lastmod ? { url: e.loc, lastmod: e.lastmod.slice(0, 64) } : { url: e.loc }));
      await writer.append(snapshotId, batch);
      progress?.({ stage: "saving", saved: Math.min(i + BATCH, got.entries.length), urls: got.entries.length });
    }
    const result = await writer.finish(snapshotId, { filesRead: got.filesRead, truncated: got.truncated, problems: got.problems });
    return { state: "complete", urlCount: got.entries.length, problems: got.problems, ...result };
  } catch (e) {
    const problems = [...got.problems, (e as Error).message ?? String(e)].slice(-20);
    await writer.markFailed(snapshotId, { filesRead: got.filesRead, problems }).catch(() => undefined);
    return { state: "failed", urlCount: 0, problems };
  }
}

export { MAX_FILES };
