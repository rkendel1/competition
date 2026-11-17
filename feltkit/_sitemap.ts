/**
 * Pure sitemap rules: parse sitemap XML, classify URLs, extract who a page targets, and diff two
 * snapshots. No I/O and no clock reads here, so every rule is testable and deterministic.
 *
 * A file whose name starts with `_` is a helper, not a function module.
 */

export type Category = "vs" | "alternative" | "industry" | "solution";

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export interface ParsedSitemap {
  kind: "urlset" | "index" | "unknown";
  entries: SitemapEntry[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  const raw = text.trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1");
  return raw
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
}

function child(block: string, tag: string): string | undefined {
  // Namespaced tags (e.g. <sm:loc>) are accepted too.
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i").exec(block);
  return m ? decode(m[1]!) : undefined;
}

/**
 * Parses a sitemap (<urlset>) or a sitemap index (<sitemapindex>). Tolerant of namespaces, CDATA
 * and entities; ignores image/video/news extensions. Never throws on malformed input: an
 * unrecognised document is `kind: "unknown"` with no entries.
 */
export function parseSitemap(xml: string): ParsedSitemap {
  const isIndex = /<(?:[\w-]+:)?sitemapindex\b/i.test(xml);
  const isUrlset = /<(?:[\w-]+:)?urlset\b/i.test(xml);
  if (!isIndex && !isUrlset) return { kind: "unknown", entries: [] };
  const tag = isIndex ? "sitemap" : "url";
  const blockRe = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(blockRe)) {
    const loc = child(m[1]!, "loc");
    if (!loc) continue;
    const lastmod = child(m[1]!, "lastmod");
    entries.push(lastmod ? { loc, lastmod } : { loc });
  }
  return { kind: isIndex ? "index" : "urlset", entries };
}

/** A lastmod value as epoch milliseconds, or undefined when it is not a W3C date. */
export function lastmodMs(lastmod: string | undefined): number | undefined {
  if (!lastmod) return undefined;
  if (!/^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(lastmod.trim())) return undefined;
  const ms = Date.parse(lastmod.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Path segments, lowercased, without empties or a trailing file extension. */
function segments(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponentSafe(s).replace(/\.(html?|php|aspx?)$/, ""));
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const SECTION: Record<string, Category> = {
  vs: "vs",
  versus: "vs",
  compare: "vs",
  comparison: "vs",
  comparisons: "vs",
  alternative: "alternative",
  alternatives: "alternative",
  industries: "industry",
  industry: "industry",
  solutions: "solution",
  solution: "solution",
  "use-cases": "solution",
  "use-case": "solution",
};

/**
 * The categories a URL belongs to. Section directories (/vs/, /alternative(s)/, /industries/,
 * /solutions/, plus common variants) and slug forms ("a-vs-b", "x-alternative(s)") both count.
 * A section's own index page (e.g. "/industries/") counts too: it is part of the section.
 */
export function classify(url: string): Category[] {
  const segs = segments(pathOf(url));
  const out = new Set<Category>();
  for (const seg of segs) {
    const section = SECTION[seg];
    if (section) out.add(section);
    if (/(^|-)(vs|versus)(-|$)/.test(seg)) out.add("vs");
    if (/(^|-)alternatives?(-|$)/.test(seg) && seg !== "alternative" && seg !== "alternatives") out.add("alternative");
  }
  return [...out].sort();
}

function humanize(slug: string): string {
  return slug.replace(/[-_]+/g, " ").trim();
}

/** Normalises a brand for comparison: "Acme.io" / "acme-io" / "ACME" → "acme". */
export function brandKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.(com|io|ai|co|app|net|org|dev|so|hq)(\/.*)?$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

const NOISE = new Set(["", "index", "all", "overview", "page"]);

/**
 * Whom a /vs/ or /alternative/ page is aimed at, as a readable name, or undefined for a
 * section index. `ownBrand` is the competitor itself, so "competitor-vs-hubspot" yields
 * "hubspot" rather than the competitor's own name.
 */
export function targetOf(url: string, ownBrand: string): string | undefined {
  const segs = segments(pathOf(url));
  const own = brandKey(ownBrand);
  const notOwn = (slug: string) => slug && !NOISE.has(slug) && brandKey(slug) !== own;
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i]!;
    // "a-vs-b" in one segment.
    const vs = seg.split(/-(?:vs|versus)-/);
    if (vs.length === 2) {
      const pick = [vs[1]!, vs[0]!].find(notOwn);
      if (pick) return humanize(pick.replace(/-alternatives?$/, ""));
    }
    // "x-alternative(s)" / "alternative(s)-to-x".
    const alt = /^(?:(.+)-alternatives?|alternatives?-to-(.+))$/.exec(seg);
    if (alt) {
      const pick = alt[1] ?? alt[2];
      if (pick && notOwn(pick)) return humanize(pick);
    }
    // "/vs/<slug>" or "/alternatives/<slug>": the segment after a section directory.
    const prev = segs[i - 1];
    if (prev && (SECTION[prev] === "vs" || SECTION[prev] === "alternative") && !SECTION[seg] && notOwn(seg)) {
      return humanize(seg.replace(/^(vs|versus)-/, "").replace(/-(vs|versus)$/, ""));
    }
  }
  return undefined;
}

/** True when the page's target is the given brand ("they're coming for you"). */
export function targetsBrand(target: string | undefined, brand: string): boolean {
  if (!target || !brand.trim()) return false;
  return brandKey(target) === brandKey(brand);
}

export interface Diff {
  added: string[];
  removed: string[];
}

/** URLs present in `current` and not in `previous`, and the reverse. Sorted, deterministic. */
export function diffUrls(previous: Iterable<string>, current: Iterable<string>): Diff {
  const prev = new Set(previous);
  const cur = new Set(current);
  return {
    added: [...cur].filter((u) => !prev.has(u)).sort(),
    removed: [...prev].filter((u) => !cur.has(u)).sort(),
  };
}

/**
 * Search terms to bid on against a competitor: both orders of "you vs them" and "them
 * alternative(s)". Deterministic and deduplicated; empty when your brand is not set.
 */
export function bidTerms(yourBrand: string, competitorName: string): string[] {
  const you = yourBrand.trim();
  const them = competitorName.trim();
  if (!you || !them) return [];
  return [...new Set([`${you} vs ${them}`, `${them} vs ${you}`, `${them} alternative`, `${them} alternatives`])];
}

/** Rejects non-web and private-network URLs before anything is fetched. */
export function checkFetchableUrl(raw: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https sitemaps can be fetched.");
  if (url.username || url.password) throw new Error("A sitemap URL must not carry credentials.");
  if (!allowPrivate && isPrivateHost(url.hostname)) throw new Error(`${url.hostname} is a private or local address.`);
  return url;
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  return false;
}

/** The sitemap URL to try for a domain or URL a person typed. */
export function defaultSitemapUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (/\.xml(\.gz)?$/i.test(url.pathname)) return url.toString();
  return `${url.origin}/sitemap.xml`;
}

export function domainOf(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withScheme).hostname.replace(/^www\./, "").toLowerCase();
}
