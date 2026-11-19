/** Reading a snapshot's pages: chunks (current) plus any legacy per-URL rows not yet compacted. */
import type { QueryCtx } from "@feltdb/feltkit";
import { pageChunks, pages } from "./app.js";

export interface PageRec {
  url: string;
  lastmod?: string | undefined;
  lastmodMs?: number | undefined;
  categories: Array<"vs" | "alternative" | "industry" | "solution">;
  target?: string | undefined;
}

export async function readPages(ctx: { db: QueryCtx["db"] }, snapshotId: string): Promise<PageRec[]> {
  const [chunks, legacy] = await Promise.all([ctx.db.find(pageChunks, { snapshotId }), ctx.db.find(pages, { snapshotId })]);
  const out: PageRec[] = chunks.flatMap((c) => c.items);
  for (const x of legacy) out.push({ url: x.url, lastmod: x.lastmod, lastmodMs: x.lastmodMs, categories: x.categories, target: x.target });
  return out;
}
