/**
 * Reading a competitor's own pages: homepage, then its pricing and about pages (found from the
 * homepage's links, else the conventional paths). Best effort: a page that cannot be read is
 * left out, never a reason to fail the capture. Uses the same guarded fetch as sitemaps.
 */
import { aboutSummary, findLink, parsePage, pricingSignals, type SiteFacts } from "../feltkit/_site.js";
import type { FetchText } from "../feltkit/_collect.js";

export async function scrapeSite(domain: string, fetchText: FetchText): Promise<{ site?: SiteFacts; problems: string[] }> {
  const problems: string[] = [];
  const homeUrl = `https://${domain}/`;
  let html: string;
  try {
    html = await fetchText(homeUrl);
  } catch (e) {
    return { problems: [`Homepage not read: ${(e as Error).message}`] };
  }
  const home = parsePage(html, homeUrl);
  const site: SiteFacts = {
    homepage: { url: homeUrl, ...(home.title ? { title: home.title } : {}), ...(home.description ? { description: home.description } : {}), ...(home.headline ? { headline: home.headline } : {}) },
  };

  const pricingUrl = findLink(home.links, domain, /\/(pricing|plans)\b|^\s*pricing\s*$/i) ?? `https://${domain}/pricing`;
  try {
    site.pricing = { url: pricingUrl, ...pricingSignals(await fetchText(pricingUrl)) };
  } catch (e) {
    problems.push(`Pricing page not read (${pricingUrl}): ${(e as Error).message}`);
  }

  const aboutUrl = findLink(home.links, domain, /\/(about|company|about-us)\b|^\s*(about|about us|company)\s*$/i) ?? `https://${domain}/about`;
  try {
    const summary = aboutSummary(await fetchText(aboutUrl));
    site.about = { url: aboutUrl, ...(summary ? { summary } : {}) };
  } catch (e) {
    problems.push(`About page not read (${aboutUrl}): ${(e as Error).message}`);
  }
  return { site, problems };
}
