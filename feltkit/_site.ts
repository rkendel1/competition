/**
 * Pure rules for reading a competitor's own pages (homepage, pricing, about), for suggesting
 * competitors to track, and for writing the summary. No I/O and no clock reads, so every rule is
 * testable and deterministic. No model is involved: everything here is derived from fetched HTML
 * and from stored sitemap snapshots.
 *
 * A file whose name starts with `_` is a helper, not a function module.
 */
import { brandKey } from "./_sitemap.js";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ndash: "–", mdash: "—" };

function decode(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|ndash|mdash);/g, (_, e: string) => ENTITIES[e]!)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** Visible text: tags, scripts and styles removed, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function meta(html: string, key: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (name !== key) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const value = decode(content?.[1] ?? content?.[2] ?? "").replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return undefined;
}

export interface Link {
  href: string;
  text: string;
}

export interface PageFacts {
  title?: string;
  description?: string;
  headline?: string;
  siteName?: string;
  links: Link[];
}

const clip = (s: string | undefined, max: number) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** What a page says about itself. `base` resolves relative links; only http(s) links are kept. */
export function parsePage(html: string, base: string): PageFacts {
  const head = html.slice(0, 600_000);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(head)?.[1];
  const links: Link[] = [];
  for (const m of head.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) continue;
    try {
      const u = new URL(raw, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      links.push({ href: u.toString(), text: textOf(m[3]!).slice(0, 60) });
    } catch {
      /* not a URL */
    }
    if (links.length >= 400) break;
  }
  const facts: PageFacts = { links };
  const t = title && textOf(title);
  const d = meta(head, "description") ?? meta(head, "og:description");
  const hl = h1 && textOf(h1);
  const sn = meta(head, "og:site_name");
  if (t) facts.title = clip(t, 200)!;
  if (d) facts.description = clip(d, 400)!;
  if (hl) facts.headline = clip(hl, 200)!;
  if (sn) facts.siteName = clip(sn, 80)!;
  return facts;
}

/** The first same-site link whose path or text matches, e.g. the pricing page. */
export function findLink(links: Link[], host: string, pattern: RegExp): string | undefined {
  const same = (h: string) => new URL(h).hostname.replace(/^www\./, "") === host.replace(/^www\./, "");
  return links.find((l) => same(l.href) && (pattern.test(new URL(l.href).pathname) || pattern.test(l.text)))?.href;
}

export interface PricingSignals {
  free: boolean;
  trial: boolean;
  contactSales: boolean;
  /** Distinct price points as written, e.g. "$29", "€99", in page order (at most 8). */
  prices: string[];
  /** Plan names found near the word "plan" or in common tier names (at most 6). */
  plans: string[];
}

const TIERS = ["Free", "Starter", "Basic", "Hobby", "Personal", "Pro", "Plus", "Team", "Teams", "Business", "Growth", "Scale", "Premium", "Enterprise", "Standard", "Essential", "Advanced"];

/** What a pricing page reveals: tiers, price points, and whether there is a free plan or trial. */
export function pricingSignals(html: string): PricingSignals {
  const text = textOf(html);
  const prices = [...new Set([...text.matchAll(/[$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g)].map((m) => m[0].replace(/\s/g, "")))].slice(0, 8);
  const plans = TIERS.filter((t) => new RegExp(`\\b${t}\\b`).test(text)).slice(0, 6);
  return {
    free: /\bfree (plan|forever|tier)\b|\bfree\b[^.]{0,20}\$0|\$0\b/i.test(text) || plans.includes("Free"),
    trial: /\b(free trial|try (it )?free|start (a )?free)\b/i.test(text),
    contactSales: /\b(contact sales|talk to sales|custom pricing|book a demo)\b/i.test(text),
    prices,
    plans,
  };
}

export interface SiteFacts {
  homepage: { url: string; title?: string; description?: string; headline?: string };
  pricing?: { url: string } & PricingSignals;
  about?: { url: string; summary?: string };
}

/** First sentences of the page's own text, as a short plain-language description. */
export function aboutSummary(html: string): string | undefined {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
  const paragraphs = [...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => textOf(m[1]!)).filter((p) => p.length >= 60);
  const joined = paragraphs.slice(0, 2).join(" ");
  return joined ? clip(joined, 400) : undefined;
}

/** What changed between two captures of the same competitor's site, in words. */
export function siteChanges(prev: SiteFacts | undefined, next: SiteFacts): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const h = (x: SiteFacts) => x.homepage;
  if (h(prev).headline !== h(next).headline && h(next).headline) out.push(`Homepage headline is now “${h(next).headline}”.`);
  if (h(prev).description !== h(next).description && h(next).description) out.push("Homepage description changed.");
  const pp = prev.pricing;
  const np = next.pricing;
  if (np && !pp) out.push("A pricing page appeared.");
  if (pp && np) {
    if (pp.prices.join("|") !== np.prices.join("|")) out.push(`Prices changed: ${pp.prices.join(", ") || "none"} → ${np.prices.join(", ") || "none"}.`);
    if (pp.free !== np.free) out.push(np.free ? "A free plan appeared." : "The free plan is gone.");
    if (pp.trial !== np.trial) out.push(np.trial ? "A free trial appeared." : "The free trial is gone.");
    const added = np.plans.filter((x) => !pp.plans.includes(x));
    if (added.length) out.push(`New plan names: ${added.join(", ")}.`);
  }
  return out;
}

// ---------- suggestions ----------

export interface Mention {
  /** The tracked competitor whose page names the target. */
  by: string;
  target: string;
  pages: number;
}

export interface Suggestion {
  name: string;
  /** Tracked competitors that position against it, most first. */
  namedBy: string[];
  pages: number;
  /** A guess at its domain (name.com). Always confirm before tracking. */
  domainGuess: string;
}

/**
 * Names that tracked competitors attack in their /vs/ and /alternative/ pages but that you do not
 * track yet: the market's own shortlist. Ranked by how many different competitors name them, then
 * by pages. `tracked` are names and domains already tracked; `brand` is your own brand (never
 * suggested).
 */
export function suggest(mentions: Mention[], tracked: string[], brand: string, limit = 8): Suggestion[] {
  const skip = new Set([...tracked, brand].map(brandKey).filter(Boolean));
  const byKey = new Map<string, { name: string; by: Map<string, number>; pages: number }>();
  for (const m of mentions) {
    const key = brandKey(m.target);
    if (!key || skip.has(key)) continue;
    const e = byKey.get(key) ?? { name: m.target, by: new Map(), pages: 0 };
    e.by.set(m.by, (e.by.get(m.by) ?? 0) + m.pages);
    e.pages += m.pages;
    byKey.set(key, e);
  }
  return [...byKey.entries()]
    .map(([key, e]) => ({
      name: e.name.replace(/\b\w/g, (c) => c.toUpperCase()),
      namedBy: [...e.by.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n),
      pages: e.pages,
      domainGuess: `${key}.com`,
    }))
    .sort((a, b) => b.namedBy.length - a.namedBy.length || b.pages - a.pages || (a.name < b.name ? -1 : 1))
    .slice(0, limit);
}

// ---------- summary ----------

export interface CompetitorDigest {
  name: string;
  domain: string;
  /** From the latest complete snapshot; undefined when none yet. */
  snapshot?: { urls: number; completedAt: number };
  attackTargets: string[];
  targetsYou: number;
  markets: string[];
  addedPages: number;
  newMarkets: string[];
  site?: SiteFacts & { changes: string[] };
}

export interface Summary {
  headline: string;
  sections: Array<{ title: string; bullets: string[] }>;
  /** The same content as Markdown, for pasting into a doc or message. */
  markdown: string;
}

const list = (xs: string[], max = 4) => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A summary of every tracked competitor, derived only from the digests. Deterministic. */
export function summarize(brand: string, digests: CompetitorDigest[], suggestions: Suggestion[]): Summary {
  const captured = digests.filter((d) => d.snapshot);
  const sections: Summary["sections"] = [];

  const coming = captured.filter((d) => d.targetsYou > 0);
  const threats: string[] = [];
  for (const d of coming) threats.push(`${d.name} has ${plural(d.targetsYou, "page")} aimed at ${brand || "you"}.`);
  if (threats.length) sections.push({ title: "Aimed at you", bullets: threats });

  const moves: string[] = [];
  for (const d of captured) {
    if (d.newMarkets.length) moves.push(`${d.name} entered ${list(d.newMarkets)} since the last capture.`);
    else if (d.addedPages > 0) moves.push(`${d.name} added ${plural(d.addedPages, "page")} since the last capture.`);
    for (const c of d.site?.changes ?? []) moves.push(`${d.name}: ${c}`);
  }
  if (moves.length) sections.push({ title: "What moved", bullets: moves });

  const positioning: string[] = [];
  for (const d of digests) {
    const line = [d.site?.homepage.headline ? `“${d.site.homepage.headline}”` : d.site?.homepage.description];
    const attack = d.attackTargets.length ? `positions against ${list(d.attackTargets)}` : undefined;
    const mk = d.markets.length ? `sells into ${list(d.markets)}` : undefined;
    const parts = [line[0], attack, mk].filter(Boolean);
    positioning.push(parts.length ? `${d.name}: ${parts.join("; ")}.` : `${d.name}: no data captured yet.`);
  }
  if (positioning.length) sections.push({ title: "How each competitor positions itself", bullets: positioning });

  const pricing: string[] = [];
  for (const d of digests) {
    const p = d.site?.pricing;
    if (!p) continue;
    const bits = [p.prices.length ? `from ${p.prices[0]}` : undefined, p.free ? "free plan" : undefined, p.trial ? "free trial" : undefined, p.contactSales ? "sales-led tier" : undefined, p.plans.length ? `tiers: ${p.plans.join(", ")}` : undefined].filter(Boolean);
    if (bits.length) pricing.push(`${d.name}: ${bits.join(", ")}.`);
  }
  if (pricing.length) sections.push({ title: "Pricing signals", bullets: pricing });

  const shared = new Map<string, string[]>();
  for (const d of captured) for (const m of d.markets) shared.set(m, [...(shared.get(m) ?? []), d.name]);
  const crowded = [...shared.entries()].filter(([, who]) => who.length > 1).sort((a, b) => b[1].length - a[1].length);
  if (crowded.length) sections.push({ title: "Crowded markets", bullets: crowded.slice(0, 5).map(([m, who]) => `${m}: ${list(who)} all have pages for it.`) });

  if (suggestions.length) {
    sections.push({
      title: "Worth tracking next",
      bullets: suggestions.slice(0, 5).map((x) => `${x.name} (named by ${list(x.namedBy)}).`),
    });
  }

  const headline = !digests.length
    ? "No competitors tracked yet."
    : !captured.length
      ? `Tracking ${plural(digests.length, "competitor")}; none captured yet.`
      : coming.length
        ? `${plural(coming.length, "competitor")} ${coming.length === 1 ? "is" : "are"} targeting ${brand || "you"}. Tracking ${digests.length} in total.`
        : `Tracking ${plural(digests.length, "competitor")}; none are targeting ${brand || "you"} directly.`;

  const markdown = [`# Competitor summary`, "", headline, ...sections.flatMap((s) => ["", `## ${s.title}`, ...s.bullets.map((b) => `- ${b}`)])].join("\n");
  return { headline, sections, markdown };
}
