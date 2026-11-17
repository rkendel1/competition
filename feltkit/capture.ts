/**
 * Pasting a sitemap: `capture:paste`. For sites that block automated requests, a person opens the
 * sitemap in their browser and pastes it. No network is used here; fetching sitemaps is the
 * capturer component's job (gateway/capturer.ts), on request (`snapshots:request`) or on a
 * schedule (`schedule:set`).
 */
import { s } from "@feltdb/feltkit";
import { api } from "./_generated/api.js";
import { app } from "./app.js";
import { collect, write } from "./_collect.js";

export const paste = app.action({
  access: "intel.write",
  args: { competitorId: s.string(), xml: s.string({ minLength: 1, maxLength: 20_000_000 }) },
  returns: s.object({
    snapshotId: s.string(),
    state: s.enum(["complete", "failed"]),
    urlCount: s.integer(),
    problems: s.array(s.string()),
    newSignals: s.optional(s.integer()),
    newTargetingYou: s.optional(s.integer()),
  }),
  handler: async (ctx, { competitorId, xml }) => {
    const snapshotId = await ctx.runMutation(api.snapshots.begin, { competitorId });
    const progress = (p: object) => ctx.emit({ type: "progress", ...p });
    const got = await collect({ pasted: xml }, null, progress);
    const result = await write(
      snapshotId,
      got,
      {
        append: (id, pages) => ctx.runMutation(api.snapshots.append, { snapshotId: id, pages }),
        finish: (id, meta) => ctx.runMutation(api.snapshots.finish, { snapshotId: id, ...meta }),
        markFailed: (id, meta) => ctx.runMutation(api.snapshots.markFailed, { snapshotId: id, ...meta }),
      },
      progress,
    );
    return { snapshotId, ...result };
  },
});
