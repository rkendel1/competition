/**
 * The only network code in the application: reading public sitemaps for the capturer component.
 * http and https only; no credentials in URLs; private, loopback and link-local hosts refused,
 * checked on the hostname and on every resolved address, at every redirect hop; a timeout and a
 * size cap per file; gzip read transparently.
 */
import { lookup } from "node:dns/promises";
import { checkFetchableUrl, isPrivateHost } from "../feltkit/_sitemap.js";

const MAX_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "sitemap-intel/0.2 (competitive research; reads public sitemaps)";

export interface FetchOptions {
  /** Development and tests only: allow private and loopback hosts (local fixtures). */
  allowPrivate?: boolean;
  signal?: AbortSignal;
}

async function assertPublic(url: URL, allowPrivate: boolean) {
  checkFetchableUrl(url.toString(), allowPrivate);
  if (allowPrivate) return;
  const addrs = await lookup(url.hostname, { all: true }).catch(() => {
    throw new Error(`${url.hostname} does not resolve.`);
  });
  if (addrs.some((a) => isPrivateHost(a.address))) throw new Error(`${url.hostname} resolves to a private address.`);
}

export async function fetchText(raw: string, options: FetchOptions = {}): Promise<string> {
  let url = new URL(raw);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(url, options.allowPrivate === true);
    const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])];
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any(signals),
      headers: { "user-agent": USER_AGENT, accept: "application/xml,text/xml,text/plain,*/*" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await readCapped(res);
    const data = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
    return new TextDecoder("utf-8").decode(data);
  }
  throw new Error("Too many redirects.");
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`larger than ${MAX_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.byteLength));
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
