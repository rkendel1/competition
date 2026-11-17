/** Queueing captures: shared by snapshots:request and schedule:claimDue. */
import type { MutationCtx } from "@feltdb/feltkit";
import { snapshots } from "./app.js";

/** A snapshot that is queued or collecting for this competitor, if any. */
export async function inFlight(ctx: { db: MutationCtx["db"] }, competitorId: string) {
  return (await ctx.db.find(snapshots, { competitorId })).find((x) => x.state === "queued" || x.state === "collecting");
}

/** Queues a capture and records the capturer's work in the same transaction. */
export async function enqueueCapture(ctx: MutationCtx, competitorId: string, trigger: "manual" | "schedule", requestedBy: string): Promise<string> {
  const snapshotId = await ctx.db.insert(snapshots, {
    competitorId,
    source: "fetch",
    state: "queued",
    trigger,
    requestedBy,
    startedAt: Date.now(),
    takenBy: "component:capturer",
    urlCount: 0,
    filesRead: [],
    truncated: false,
    problems: [],
  });
  ctx.afterCommit.work("capturer", "capture", { snapshotId });
  return snapshotId;
}

