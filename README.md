# Sitemap Intel

Competitor intelligence from the one file every competitor has to publish: their sitemap.

A sitemap lists every page a site wants search engines to find. Read it on a schedule and it tells you:

| Signal | Where it comes from | What it means |
|---|---|---|
| **Who they attack** | `/vs/`, `/versus/`, `/compare/`, `a-vs-b` and `/alternative(s)/`, `x-alternative(s)` pages | Every competitor they position against. A `/vs/<your-brand>/` page means they're coming for you. |
| **What changed** | `<lastmod>` on each URL, newest first within 7, 30 or 90 days | What they worked on recently. |
| **Their markets** | `/industries/`, `/solutions/`, `/use-cases/` pages | Markets they're going after. A new industry page is a new market. |
| **What's new** | The difference between two snapshots | Pages added and removed since you last looked. |
| **What to bid on** | Your brand and theirs | `you vs them`, `them vs you`, `them alternative(s)`, plus a CSV that includes the brands *they* compare against. |

It's a [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit) app. Every competitor, snapshot and page is stored in the app's own FeltDB instance, so you keep the history and can rebuild any report from it.

## Run it

```bash
npm install
npm run dev
```

Open the app URL it prints. In development you're signed in as **Ada** (member + admin). **Grace** is a viewer: she can read reports but can't change anything.

1. Set **Your brand** in the sidebar.
2. Add a competitor by domain (`acme.com`) or by sitemap URL (`https://acme.com/sitemap_index.xml`).
3. Choose how to capture it:
   - **Capture now**: the app's capturer fetches the sitemap right away.
   - **Schedule**: pick daily, weekly or monthly and when the first capture should run, in your own time zone. The capturer then runs it by itself, with no API key, no cron job and nobody signed in.
   - **Paste XML**: for sites that block automated requests, open the sitemap in your browser and paste it.

The capturer starts from `/sitemap.xml`. If that fails, it reads the `Sitemap:` lines in `robots.txt`. It follows sitemap indexes, reads gzipped sitemaps, and checks every redirect hop.

## How scheduled captures work

```
person ──schedule:set──▶ competitor.schedule { cadence, anchor, nextRunAt }       (FeltDB)
                                   │
capturer component, every 30 s ──schedule:claimDue──▶ one transaction:
                                   ├─ snapshot "queued"
                                   ├─ durable work for the capturer   (ctx.afterCommit.work → FeltKit outbox)
                                   └─ nextRunAt advanced
capturer, every 3 s ──work.claim (leased)──▶ snapshots:start → fetch → append… → finish
```

- **No API key, no person's session.** The capturer is a FeltKit runtime component (`gateway/capturer.ts`). It runs inside the app's own process as its declared principal, `component:capturer`, whose role `capturer` grants only `intel.read` and `intel.capture`. A person's authority is used once, when they set the schedule (`intel.write`), and the snapshot records who set it.
- **Exactly once.** A due schedule is queued and advanced in the same transaction, so a crash either loses nothing or queues the capture once. Work survives restarts (the FeltKit outbox). If a capture is interrupted, its lease expires and the snapshot is marked failed and restarted fresh, so a half-written capture never counts as complete.
- **No drift, no pile-ups.** Runs are the first run plus whole periods; monthly keeps the day, clamped in short months. If the app was down, missed runs collapse into one.
- **Why not AppPort Services' Schedules?** Three reasons:
  - Its jobs run as the person who created the schedule, and are refused once that person has no active session or key. Sessions last 7 days by default, so a monthly schedule would quietly stop.
  - Its jobs can only run mutations, which can't touch the network.
  - Functions can't create schedules, so the app couldn't offer this setting.
- **Status:** `GET /capturer/status` shows the last schedule check and how many captures are done or failed. `/_feltkit/health` includes the capturer: the app reports ready only while it is ready, and degraded if schedule checks fail.

| Path | What it is |
|---|---|
| `feltkit/_sitemap.ts`, `feltkit/_schedule.ts` | The rules, as pure functions with no I/O: parsing, classification, who a page targets, diffs, bid terms, the URL guard, and the next-run arithmetic. |
| `feltkit/_collect.ts` | Reads a sitemap tree and writes it as a snapshot. The network is passed in, so the capturer, the paste path and the tests share one routine. |
| `feltkit/app.ts` | Roles, the `capturer` component declaration, and collections: `profile`, `competitors` (with `schedule`), `snapshots`, `pages`. |
| `feltkit/schedule.ts` | `set` and `clear` (people), and `claimDue` (the capturer). |
| `feltkit/snapshots.ts` | `request` ("Capture now"), and the lifecycle: `start`, `begin`, `append`, `finish`, `markFailed`. `finish` emits the `snapshot.completed` webhook. |
| `feltkit/capture.ts` | `capture:paste`: pasted XML, no network. |
| `feltkit/intel.ts` | Competitors, your brand, deleting snapshots in batches, and `intel:report`. |
| `gateway/capturer.ts` | The component: its two loops, the status route and health. |
| `gateway/worker.ts`, `gateway/http.ts` | What one capture does, and the only network code in the app. |
| `src/Intel.tsx` | The UI. It only presents what the functions return. |

**Exposed to agents through AppPort/MCP:** `intel.report`, `intel.competitors` and `intel.profile` are read-only for the `agent` role. Members also have `intel.addcompetitor`, `intel.capturenow` and `intel.schedule`.

**Limits:** 60 sitemap files and 50,000 URLs per capture, 50 MB per file, 20 s per request. A truncated capture says so in its notes.

**Safety:** The capturer fetches only `http` and `https` URLs. It refuses URLs with credentials, and hosts that are private, loopback or link-local, checking both the hostname and its resolved addresses at every redirect hop. `SITEMAP_INTEL_ALLOW_PRIVATE=1` lifts that check, outside production only. Only tests and local demos use it, to read local fixtures.

## Test

```bash
npm test
```

- `tests/sitemap.test.ts`, `tests/schedule.test.ts`: the pure rules. Monthly clamping, no drift, and missed runs collapsing into one.
- `tests/intel.test.ts`: end to end against a real FeltDB per test, with the capturer's code run as its own principal. It covers:
  - "Capture now", an index, a redirect, a gzipped child, the robots.txt fallback and a 404 child;
  - schedules claimed exactly once and advanced, including after downtime;
  - interrupted captures restarted fresh;
  - the private-network guard, roles, pasting, and a 20,001-URL capture.
- `tests/capturer.e2e.test.ts`: boots `feltkit dev` with the real component. Ada sets a schedule and signs out; the capture then happens by itself as `component:capturer`, and "Capture now" goes through the same path.

## Known limits

- **lastmod is only as honest as the site.** Some sites stamp every page with the deploy date. The report shows how many pages carry lastmod, and the "What changed" note warns about this.
- **Bot-protected sites** may refuse the fetch. Use Paste XML for those.
- **One process.** The capturer runs inside the app's process, as FeltKit components do, so schedules run while the app runs. On a host that sleeps when idle, keep at least one instance up.
- **Not yet portable to AppBoundry:** `capture:paste` is an action. Components themselves are carried to AppBoundry as `components@1`, but hosts must enable them explicitly.

Deploying, Studio and every `feltkit` command are covered in the FeltKit docs: `npx feltkit docs`.
