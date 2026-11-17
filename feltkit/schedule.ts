/**
 * Capture schedules, set by people and run by the capturer component.
 *
 * Why not AppPort Services' Schedules: its jobs run as the person who created the schedule and
 * are refused once that person has no active session or key (sessions last 7 days by default),
 * its jobs can only run mutations (no network), and functions cannot create schedules, so the app
 * could not offer the setting. Here the schedule is the competitor's own data, a person's
 * authority is exercised when they set it, and the application's capturer (a declared component
 * principal, no session, no API key) performs it.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, competitors } from "./app.js";
import { nextRunAfter } from "./_schedule.js";
import { enqueueCapture, inFlight } from "./_capture.js";

export const set = app.mutation({
  access: "intel.write",
  args: {
    competitorId: s.string(),
    cadence: s.enum(["daily", "weekly", "monthly"]),
    /** The first run, as an instant (the person picks a local date and time; the browser converts it). */
    firstRunAt: s.number(),
    now: s.optional(s.number()),
  },
  returns: s.object({ nextRunAt: s.number() }),
  capability: { name: "intel.schedule", description: "Capture a competitor's sitemap daily, weekly or monthly, starting at a given time." },
  handler: async (ctx, { competitorId, cadence, firstRunAt, now = Date.now() }) => {
    const c = await ctx.db.get(competitors, competitorId);
    if (!c) fail("NOT_FOUND", "No such competitor.");
    if (!Number.isFinite(firstRunAt) || firstRunAt < Date.UTC(2000, 0, 1)) fail("INVALID_ARGUMENT", "Choose when the first capture should run.");
    const nextRunAt = nextRunAfter(cadence, firstRunAt, now - 1);
    await ctx.db.patch(competitors, competitorId, {
      schedule: { cadence, anchorAt: firstRunAt, nextRunAt, setBy: ctx.auth.requirePrincipal().id, setAt: now },
    });
    return { nextRunAt };
  },
});

export const clear = app.mutation({
  access: "intel.write",
  args: { competitorId: s.string() },
  handler: async (ctx, { competitorId }) => {
    const c = await ctx.db.get(competitors, competitorId);
    if (!c) fail("NOT_FOUND", "No such competitor.");
    if (!c.schedule) return;
    const { schedule: _drop, id: _id, __version: _v, ...rest } = c as typeof c & { __version?: number };
    await ctx.db.replace(competitors, competitorId, rest);
  },
});

/**
 * Called by the capturer on its timer. For every competitor whose schedule is due it queues a
 * capture (recording the component's work) and advances `nextRunAt` past `now`, all in one
 * transaction: a crash either loses nothing or queues it exactly once. Missed runs collapse into
 * one. A competitor already being captured is skipped this time but still advanced.
 */
export const claimDue = app.mutation({
  access: "intel.capture",
  args: { now: s.optional(s.number()) },
  returns: s.object({ queued: s.array(s.string()), skipped: s.array(s.string()) }),
  handler: async (ctx, { now = Date.now() }) => {
    const queued: string[] = [];
    const skipped: string[] = [];
    for (const c of await ctx.db.find(competitors)) {
      const sch = c.schedule;
      if (!sch || sch.nextRunAt > now) continue;
      const nextRunAt = nextRunAfter(sch.cadence, sch.anchorAt, now);
      if (await inFlight(ctx, c.id)) {
        skipped.push(c.id);
        await ctx.db.patch(competitors, c.id, { schedule: { ...sch, nextRunAt } });
        continue;
      }
      await enqueueCapture(ctx, c.id, "schedule", sch.setBy);
      await ctx.db.patch(competitors, c.id, { schedule: { ...sch, nextRunAt, lastRequestedAt: now } });
      queued.push(c.id);
    }
    return { queued, skipped };
  },
});
