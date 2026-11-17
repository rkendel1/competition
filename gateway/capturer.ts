/**
 * The capturer: a FeltKit runtime component (docs: `npx feltkit docs components`). It runs inside
 * the application's process, as the application's own declared principal (`component:capturer`,
 * role `capturer`), so scheduled captures need no person's session and no API key.
 *
 * Two loops:
 *   - every TICK_MS it asks the app which schedules are due (the app queues them transactionally);
 *   - every POLL_MS it claims queued captures (durable work, leased and fenced) and performs them.
 *
 * GET /capturer/status reports what it is doing. It changes nothing.
 */
import { defineComponent } from "@feltdb/feltkit/server";
import { fetchText } from "./http.js";
import { perform, tick, type Call } from "./worker.js";

const TICK_MS = Number(process.env.SITEMAP_INTEL_TICK_MS ?? 30_000);
const POLL_MS = Number(process.env.SITEMAP_INTEL_POLL_MS ?? 3_000);
const LEASE_MS = 15 * 60_000;

export default defineComponent(async (ctx) => {
  const allowPrivate = !ctx.environment.production && process.env.SITEMAP_INTEL_ALLOW_PRIVATE === "1";
  const call: Call = (name, args) => ctx.call(name, args);
  const status = { lastTick: 0, lastTickError: null as string | null, running: 0, done: 0, failed: 0, lastError: null as string | null };
  let closed = false;
  let busy = false;

  const work = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      const items = await ctx.work.claim({ kinds: ["capture"], limit: 2, leaseMs: LEASE_MS });
      await Promise.all(
        items.map(async (item) => {
          status.running++;
          try {
            const r = await perform(call, (url) => fetchText(url, { allowPrivate }), item.input);
            if (r.state === "failed") status.failed++;
            else status.done++;
            // The snapshot records success or failure itself; the work item is done either way.
            // A failed capture is not retried automatically: the next schedule (or a person) runs it again.
            await ctx.work.finish(item, { outcome: "done", receipt: { snapshotId: r.snapshotId ?? null, state: r.state ?? r.outcome, urls: r.urlCount ?? 0 } });
          } catch (e) {
            status.lastError = (e as Error).message;
            ctx.log.error(`capture failed: ${status.lastError}`);
            await ctx.work.finish(item, { outcome: "retry", error: { message: status.lastError } }).catch(() => undefined);
          } finally {
            status.running--;
          }
        }),
      );
    } catch (e) {
      status.lastError = (e as Error).message;
    } finally {
      busy = false;
    }
  };

  const due = async () => {
    if (closed) return;
    try {
      const r = await tick(call);
      status.lastTick = Date.now();
      status.lastTickError = null;
      if (r.queued.length) {
        ctx.log.info(`queued ${r.queued.length} scheduled capture(s)`);
        void work();
      }
    } catch (e) {
      status.lastTickError = (e as Error).message;
      ctx.log.warn(`schedule check failed: ${status.lastTickError}`);
    }
  };

  const tickTimer = setInterval(() => void due(), TICK_MS);
  const pollTimer = setInterval(() => void work(), POLL_MS);
  void due();
  void work();

  return {
    async request(req, res) {
      if (req.method !== "GET" || !req.url?.startsWith("/capturer/status")) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...status, tickMs: TICK_MS, pollMs: POLL_MS }));
    },
    health() {
      if (status.lastTickError) return { state: "degraded" as const, detail: `Schedule check failing: ${status.lastTickError}` };
      return { state: "ready" as const };
    },
    async close() {
      closed = true;
      clearInterval(tickTimer);
      clearInterval(pollTimer);
    },
  };
});
