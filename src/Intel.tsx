/**
 * The workspace: competitors on the left; on the right, one competitor's report from its latest
 * complete snapshot. Every number here comes from `intel:report`; this file only presents it.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useAction, useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

type OnError = (e: unknown) => void;

const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const when = (ms?: number) => (ms ? dateFmt.format(ms) : "—");
const n = (x: number) => x.toLocaleString();

export function Workspace({ canWrite, role, signedIn, onError }: { canWrite: boolean; role: string; signedIn: boolean; onError: OnError }) {
  const competitors = useQueryState(api.intel.listCompetitors);
  const [selected, setSelected] = useState<string | null>(null);
  const list = competitors.data ?? [];
  const current = useMemo(() => list.find((c) => c.id === selected) ?? list[0] ?? null, [list, selected]);

  if (competitors.isLoading && !competitors.data) return <div className="center muted">Loading…</div>;

  return (
    <div className="workspace">
      <aside className="sidebar" aria-label="Competitors">
        <BrandSetting canWrite={canWrite} onError={onError} />
        <div className="sidebar-title">Competitors</div>
        <nav>
          {list.map((c) => (
            <button key={c.id} className={`project ${current?.id === c.id ? "active" : ""}`} onClick={() => setSelected(c.id)}>
              <span className="project-name">
                {c.name}
                <span className="sub">
                  {c.domain}
                  {c.capturing ? " · capturing" : c.schedule ? ` · ${c.schedule.cadence}` : ""}
                </span>
              </span>
              <span className="count" title={c.lastSnapshotAt ? `Last captured ${when(c.lastSnapshotAt)}` : "Not captured yet"}>
                {c.lastUrlCount !== undefined ? n(c.lastUrlCount) : "—"}
              </span>
            </button>
          ))}
        </nav>
        {canWrite ? <AddCompetitor onAdded={setSelected} onError={onError} /> : <p className="hint">{signedIn ? `You’re signed in as a ${role}: ` : "You’re a visitor: "}you can read reports but not add competitors or capture sitemaps.</p>}
      </aside>
      <main className="main wide">
        {current ? (
          <Report key={current.id} competitorId={current.id} capturing={current.capturing} schedule={current.schedule} canWrite={canWrite} onError={onError} />
        ) : (
          <div className="empty">
            <h1>Read a competitor’s sitemap</h1>
            <p className="muted">
              Every site publishes <code>/sitemap.xml</code> so search engines can find its pages. It also shows whom they compare
              themselves against (<code>/vs/</code>, <code>/alternative/</code>), what they changed recently (<code>lastmod</code>), and which
              markets they’re entering (<code>/industries/</code>, <code>/solutions/</code>). Add a competitor’s domain to start.
            </p>
            {canWrite && <AddCompetitor onAdded={setSelected} onError={onError} large />}
          </div>
        )}
      </main>
    </div>
  );
}

function BrandSetting({ canWrite, onError }: { canWrite: boolean; onError: OnError }) {
  const profile = useQueryState(api.intel.getProfile);
  const save = useMutation(api.intel.setBrand);
  const [draft, setDraft] = useState<string | null>(null);
  const brand = profile.data?.brand ?? "";
  const value = draft ?? brand;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await save({ brand: value });
      setDraft(null);
    } catch (err) {
      onError(err);
    }
  };
  return (
    <form className="brand-setting" onSubmit={submit}>
      <label className="sidebar-title" htmlFor="brand">
        Your brand
      </label>
      <input id="brand" value={value} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Acme" disabled={!canWrite} maxLength={80} />
      {draft !== null && draft !== brand && (
        <button className="primary small" type="submit">
          Save
        </button>
      )}
      {!brand && draft === null && <p className="hint tight">Set it to flag pages that target you.</p>}
    </form>
  );
}

function AddCompetitor({ onAdded, onError, large }: { onAdded: (id: string) => void; onError: OnError; large?: boolean }) {
  const add = useMutation(api.intel.addCompetitor);
  const [site, setSite] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!site.trim()) return;
    try {
      onAdded(await add({ site }));
      setSite("");
    } catch (err) {
      onError(err);
    }
  };
  return (
    <form onSubmit={submit} className={large ? "inline-form" : "new-project"}>
      <input value={site} onChange={(e) => setSite(e.target.value)} placeholder={large ? "competitor.com or its sitemap URL" : "Add competitor.com"} aria-label="Competitor domain or sitemap URL" autoFocus={large} />
      {large && (
        <button className="primary" type="submit" disabled={!site.trim()}>
          Add competitor
        </button>
      )}
    </form>
  );
}

type ReportData = NonNullable<ReturnType<typeof useQueryState<typeof api.intel.report>>["data"]>;
type Row = ReportData["attacks"][number];

function Report({ competitorId, capturing, schedule, canWrite, onError }: { competitorId: string; capturing?: "queued" | "collecting"; schedule?: Schedule; canWrite: boolean; onError: OnError }) {
  const [windowDays, setWindowDays] = useState(30);
  const report = useQueryState(api.intel.report, { competitorId, windowDays });
  const r = report.data;
  if (!r) return <div className="muted">{report.error ? String(report.error.message) : "Loading report…"}</div>;
  const t = r.totals;
  const snap = r.snapshot;

  return (
    <div className="report">
      <header className="report-head">
        <div>
          <h1>{r.competitor.name}</h1>
          <div className="muted small">
            <a href={r.competitor.sitemapUrl} target="_blank" rel="noreferrer">
              {r.competitor.sitemapUrl}
            </a>
            {snap && (
              <>
                {" · "}captured {when(snap.completedAt)} ({snap.source === "paste" ? "pasted" : "fetched"})
                {r.previous && <> · compared with {when(r.previous.completedAt)}</>}
              </>
            )}
          </div>
        </div>
        {canWrite && <Capture competitorId={competitorId} capturing={capturing} onError={onError} />}
      </header>
      <ScheduleCard key={schedule?.nextRunAt ?? "none"} competitorId={competitorId} schedule={schedule} canWrite={canWrite} onError={onError} />

      {snap?.problems.length ? (
        <details className="problems">
          <summary>
            {snap.problems.length} note{snap.problems.length > 1 ? "s" : ""} from the last capture{snap.truncated ? " (capture was truncated)" : ""}
          </summary>
          <ul>
            {snap.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {!snap ? (
        <div className="empty-card">
          <p>
            No complete snapshot yet. <strong>Capture now</strong> (or a schedule) has the app's capturer fetch <code>{r.competitor.sitemapUrl}</code> (falling back to <code>robots.txt</code>) and follows sitemap indexes. If the site blocks automated requests, open the sitemap in your browser and <strong>paste XML</strong> instead.
          </p>
          <History competitorId={competitorId} canWrite={canWrite} onError={onError} />
        </div>
      ) : (
        <>
          <div className="stats">
            <Stat label="Pages" value={n(t.urls)} hint={`${n(t.withLastmod)} with lastmod`} />
            <Stat label="Attack pages" value={n(t.vs + t.alternative)} hint={`${n(t.vs)} vs · ${n(t.alternative)} alternative`} tone={r.attacks.some((a) => a.targetsYou) ? "danger" : undefined} />
            <Stat label="Market pages" value={n(t.industry + t.solution)} hint={`${n(t.industry)} industries · ${n(t.solution)} solutions`} />
            <Stat label={`Changed, ${windowDays} days`} value={n(t.changedInWindow)} hint="by lastmod" />
            <Stat label="New since last" value={r.previous ? n(t.added) : "—"} hint={r.previous ? `${n(t.removed)} removed` : "needs 2 snapshots"} />
          </div>

          {r.attacks.some((a) => a.targetsYou) && (
            <div className="alert">
              <strong>They’re coming for you.</strong> {r.attacks.filter((a) => a.targetsYou).length} page(s) target <strong>{r.brand}</strong>:{" "}
              {r.attacks
                .filter((a) => a.targetsYou)
                .map((a) => (
                  <a key={a.url} href={a.url} target="_blank" rel="noreferrer">
                    {a.path}
                  </a>
                ))
                .reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}
            </div>
          )}

          <Section title="Who they’re attacking" note="/vs/ and /alternative/ pages: every competitor they position against.">
            {r.targets.length ? (
              <div className="chips">
                {r.targets.map((x) => (
                  <span key={x.name} className={`chip ${x.targetsYou ? "you" : ""}`} title={x.newest ? `Newest page: ${x.newest}` : undefined}>
                    {x.name} <b>{x.pages}</b>
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">No /vs/ or /alternative/ pages in this sitemap.</p>
            )}
            <Pages rows={r.attacks} empty="" showTarget />
          </Section>

          <Section
            title="What changed"
            note="Pages whose lastmod falls in the window, newest first. Sites that stamp every page on each deploy make this noisy; check how many pages share a date."
            right={
              <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} aria-label="Window">
                {[7, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    Last {d} days
                  </option>
                ))}
              </select>
            }
          >
            <Pages rows={r.recent} empty={t.withLastmod ? "Nothing changed in this window." : "This sitemap has no lastmod dates."} />
          </Section>

          <Section title="Their markets" note="/industries/ and /solutions/ pages. A new industry page is a new market.">
            <Pages rows={r.markets} empty="No industry or solution pages in this sitemap." />
          </Section>

          <Section title="New since the previous snapshot" note={r.previous ? `Compared with the snapshot of ${when(r.previous.completedAt)} (${n(r.previous.urlCount)} pages).` : "Capture again later (e.g. monthly) to see what they added and removed."}>
            {r.previous ? (
              <>
                <Pages rows={r.added} empty="No new pages." />
                {r.removed.length > 0 && (
                  <details className="removed">
                    <summary>{n(t.removed)} removed</summary>
                    <ul>
                      {r.removed.map((u) => (
                        <li key={u}>{u}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : null}
          </Section>

          <Section title="Bid on these" note="Search terms to buy before they do, pointing at your own page, not theirs.">
            {r.bidTerms.length ? <BidTerms terms={r.bidTerms} competitor={r.competitor.name} targets={r.targets.map((x) => x.name)} /> : <p className="muted">Set your brand in the sidebar to generate terms.</p>}
          </Section>

          <History competitorId={competitorId} canWrite={canWrite} onError={onError} />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function Section({ title, note, right, children }: { title: string; note?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {note && <p className="muted small">{note}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

const PAGE = 25;

function Pages({ rows, empty, showTarget }: { rows: Row[]; empty: string; showTarget?: boolean }) {
  const [shown, setShown] = useState(PAGE);
  if (!rows.length) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <>
      <table className="pages">
        <thead>
          <tr>
            <th>Page</th>
            {showTarget && <th>Target</th>}
            <th className="num">lastmod</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((x) => (
            <tr key={x.url} className={x.targetsYou ? "you" : ""}>
              <td>
                <a href={x.url} target="_blank" rel="noreferrer">
                  {x.path}
                </a>
                {x.isNew && <span className="tag new">new</span>}
                {x.categories.map((c) => (
                  <span key={c} className="tag">
                    {c}
                  </span>
                ))}
              </td>
              {showTarget && <td>{x.target ?? <span className="muted">—</span>}</td>}
              <td className="num">{x.lastmod?.slice(0, 10) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown && (
        <button className="ghost more" onClick={() => setShown((s) => s + PAGE * 4)}>
          Show more ({n(rows.length - shown)} left)
        </button>
      )}
    </>
  );
}

function BidTerms({ terms, competitor, targets }: { terms: string[]; competitor: string; targets: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = terms.join("\n");
  const csv = useMemo(() => {
    const rows = [["keyword", "match", "competitor", "why"], ...terms.map((k) => [k, "phrase", competitor, "brand comparison"])];
    // Their own targets are competitors in the same space: comparison terms worth watching.
    for (const t of targets) rows.push([`${t} vs ${competitor}`, "phrase", competitor, "they compare against " + t]);
    return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  }, [terms, competitor, targets]);
  const href = useMemo(() => URL.createObjectURL(new Blob([csv], { type: "text/csv" })), [csv]);
  useEffect(() => () => URL.revokeObjectURL(href), [href]);
  return (
    <div className="bids">
      <ul>
        {terms.map((k) => (
          <li key={k}>
            <code>{k}</code>
          </li>
        ))}
      </ul>
      <div className="row">
        <button
          className="ghost"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "Copied" : "Copy terms"}
        </button>
        <a className="ghost button" href={href} download={`${competitor.toLowerCase().replace(/\W+/g, "-")}-bid-terms.csv`}>
          Download CSV (with their targets)
        </a>
      </div>
    </div>
  );
}

function Capture({ competitorId, capturing, onError }: { competitorId: string; capturing?: "queued" | "collecting"; onError: OnError }) {
  const request = useMutation(api.snapshots.request);
  const paste = useAction(api.capture.paste);
  const [pasting, setPasting] = useState(false);
  const [xml, setXml] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const last = paste.events.filter((e) => e.type === "progress").at(-1) as { stage?: string; urls?: number; saved?: number } | undefined;

  const captureNow = async () => {
    setResult(null);
    try {
      await request({ competitorId });
    } catch (err) {
      onError(err);
    }
  };

  const savePaste = async () => {
    setResult(null);
    try {
      const r = await paste.run({ competitorId, xml });
      if (r.state === "failed") setResult(`Not saved: ${r.problems.at(-1) ?? "unknown reason"}`);
      else {
        setResult(`Saved ${n(r.urlCount)} pages.`);
        setPasting(false);
        setXml("");
      }
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="capture">
      <div className="row">
        <button className="primary" disabled={!!capturing || paste.running} onClick={() => void captureNow()} title="The app's capturer fetches the sitemap now. No API key needed.">
          {capturing === "queued" ? "Queued…" : capturing === "collecting" ? "Capturing…" : "Capture now"}
        </button>
        <button className="ghost" disabled={paste.running} onClick={() => setPasting((p) => !p)}>
          Paste XML
        </button>
      </div>
      {paste.running && last && <div className="muted small">{last.stage === "saving" ? `Saving ${n(last.saved ?? 0)} / ${n(last.urls ?? 0)}` : `Read ${n(last.urls ?? 0)} URLs`}</div>}
      {result && <div className="muted small">{result}</div>}
      {pasting && (
        <div className="paste">
          <textarea value={xml} onChange={(e) => setXml(e.target.value)} placeholder="Paste the sitemap XML (a <urlset>)" rows={6} />
          <button className="primary" disabled={!xml.trim() || paste.running} onClick={() => void savePaste()}>
            Save snapshot
          </button>
        </div>
      )}
    </div>
  );
}

type Schedule = { cadence: string; anchorAt: number; nextRunAt: number; setBy: string; lastRequestedAt?: number };

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/** A datetime-local value (the browser's own time zone) for an instant, and back. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function defaultFirstRun(): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function ScheduleCard({ competitorId, schedule, canWrite, onError }: { competitorId: string; schedule?: Schedule; canWrite: boolean; onError: OnError }) {
  const set = useMutation(api.schedule.set);
  const clear = useMutation(api.schedule.clear);
  const [editing, setEditing] = useState(false);
  const [cadence, setCadence] = useState<"daily" | "weekly" | "monthly">((schedule?.cadence as "monthly") ?? "monthly");
  const [first, setFirst] = useState(toLocalInput(schedule ? schedule.nextRunAt : defaultFirstRun()));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const firstRunAt = new Date(first).getTime(); // datetime-local is read in the browser's time zone
    try {
      await set({ competitorId, cadence, firstRunAt });
      setEditing(false);
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="schedule">
      {schedule && !editing ? (
        <div className="row">
          <span>
            <strong>Captures {schedule.cadence}</strong> · next {dateTimeFmt.format(schedule.nextRunAt)}
            {schedule.lastRequestedAt ? <span className="muted"> · last ran {when(schedule.lastRequestedAt)}</span> : null}
            <span className="muted"> · set by {schedule.setBy}</span>
          </span>
          {canWrite && (
            <>
              <button className="ghost small" onClick={() => setEditing(true)}>
                Change
              </button>
              <button className="ghost small" onClick={() => void clear({ competitorId }).catch(onError)}>
                Turn off
              </button>
            </>
          )}
        </div>
      ) : canWrite && (editing || !schedule) ? (
        <form className="row" onSubmit={save}>
          <span>Capture</span>
          <select value={cadence} onChange={(e) => setCadence(e.target.value as "monthly")} aria-label="How often">
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
          </select>
          <span>starting</span>
          <input type="datetime-local" value={first} onChange={(e) => setFirst(e.target.value)} aria-label="First capture" required />
          <span className="muted small">{zone}</span>
          <button className="primary small" type="submit">
            {schedule ? "Save" : "Schedule"}
          </button>
          {editing && (
            <button className="ghost small" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <span className="muted">No schedule.</span>
      )}
    </div>
  );
}

function History({ competitorId, canWrite, onError }: { competitorId: string; canWrite: boolean; onError: OnError }) {
  const snaps = useQueryState(api.intel.listSnapshots, { competitorId });
  const del = useMutation(api.intel.deleteSnapshot);
  const remove = useMutation(api.intel.removeCompetitor);
  const [busy, setBusy] = useState(false);
  const list = snaps.data ?? [];

  const deleteOne = async (id: string) => {
    let remaining = 1;
    while (remaining) remaining = (await del({ id })).remaining;
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Snapshots" note="Each capture is kept, so you can compare month to month.">
      {list.length ? (
        <table className="pages">
          <tbody>
            {list.map((x) => (
              <tr key={x.id}>
                <td>{when(x.completedAt ?? x.startedAt)}</td>
                <td>
                  <span className={`tag ${x.state}`}>{x.state}</span> {x.trigger ?? x.source}
                  {x.requestedBy ? <span className="muted"> · {x.requestedBy}</span> : null}
                </td>
                <td className="num">{n(x.urlCount)} pages</td>
                {canWrite && (
                  <td className="num">
                    <button className="ghost small" disabled={busy} onClick={() => void run(() => deleteOne(x.id))}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">None yet.</p>
      )}
      {canWrite && (
        <button
          className="ghost danger small"
          disabled={busy}
          onClick={() =>
            confirm("Stop tracking this competitor and delete all of its snapshots?") &&
            void run(async () => {
              for (const x of list) await deleteOne(x.id);
              await remove({ id: competitorId });
            })
          }
        >
          Stop tracking this competitor
        </button>
      )}
    </Section>
  );
}
