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
3. **Capture now** fetches the sitemap. If `/sitemap.xml` fails, it reads the `Sitemap:` lines in `robots.txt`. It follows sitemap indexes, reads gzipped sitemaps, and checks every redirect hop.
   If the site blocks automated requests, open the sitemap in your browser and use **Paste XML**.
4. Capture again next month to see what's new.

## How it's built

| Path | What it is |
|---|---|
| `feltkit/_sitemap.ts` | The rules, as pure functions with no I/O: parse sitemap XML, classify URLs, extract who a page targets, diff two snapshots, write bid terms, refuse private-network URLs. |
| `feltkit/app.ts` | Roles (`intel.read`, `intel.write`) and collections: `profile`, `competitors`, `snapshots`, `pages`. |
| `feltkit/capture.ts` | `capture:run`, the only code that touches the network. It's an **action** (not a transaction): it fetches or takes pasted XML, then writes through the snapshot mutations. |
| `feltkit/snapshots.ts` | `begin`, `append` (batches of 1,000), `finish` and `markFailed`. A snapshot stays `collecting` until `finish` commits it as `complete`, and reports only read complete snapshots. `finish` emits the `snapshot.completed` webhook, which says how many new signal pages appeared and how many target you. |
| `feltkit/intel.ts` | Competitors, your brand, snapshot deletion (in batches) and `intel:report`. |
| `src/Intel.tsx` | The UI. It only presents what `intel:report` returns. |

**Exposed to agents through AppPort/MCP** (read-only for the `agent` role): `intel.report`, `intel.competitors`, `intel.profile`. Members also have `intel.addcompetitor`.

**Limits:** 60 sitemap files and 50,000 URLs per capture, 50 MB per file, 20 s per request. A truncated capture says so in its notes.

**Safety:** Captures fetch only `http` and `https` URLs. They refuse URLs with credentials, and hosts that are private, loopback or link-local, checking both the hostname and its resolved addresses at every redirect hop. `SITEMAP_INTEL_ALLOW_PRIVATE=1` lifts that check. Only tests use it, to read local fixtures. Never set it in production.

## Test

```bash
npm test
```

- `tests/sitemap.test.ts`: the parsing and classification rules.
- `tests/intel.test.ts`: end to end against a real FeltDB per test. It covers pasted and fetched captures (an index, a redirect, a gzipped child, the robots.txt fallback, a 404 child), diffs, roles, the private-network guard, an honest failure for non-sitemaps, and a 20,001-URL capture that is reported and then deleted.

## Known limits

- **lastmod is only as honest as the site.** Some sites stamp every page with the deploy date. The report shows how many pages carry lastmod, and the "What changed" note warns about this.
- **No automatic monthly capture yet.** FeltKit jobs run mutations, but capturing needs the network, so it's an action. Schedule it from outside for now: call `capture:run` through the API with an API key, from cron or CI.
- **Bot-protected sites** may refuse the fetch. Use Paste XML for those.
- **Not portable to AppBoundry:** `capture:run` is an action, because AppBoundry artifacts have no network access.

Deploying, Studio and every `feltkit` command are covered in the FeltKit docs: `npx feltkit docs`.
