import type { LinkPreview } from "../shared/types.js";

const cache = new Map<string, { at: number; v: LinkPreview | null }>();

/** Don't fetch local or private addresses (a pasted localhost/10.x link stays a plain link). */
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|.*\.local$|.*\.internal$)/i;

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").trim();

function meta(html: string, keys: string[]): string | undefined {
  for (const k of keys) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return undefined;
}

/** Title, description, image and site of a page (Open Graph / Twitter tags, else <title>), cached for a day. */
export async function linkPreview(url: string): Promise<LinkPreview | null> {
  const hit = cache.get(url);
  // Pages with a card are kept a day; misses (timeouts, no tags) are retried after 10 minutes.
  if (hit && Date.now() - hit.at < (hit.v ? 24 * 3600_000 : 600_000)) return hit.v;
  let v: LinkPreview | null = null;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) throw new Error("skip");
    const r = await fetch(u, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok || !/html/i.test(r.headers.get("content-type") ?? "")) throw new Error("not html");
    // Only the head matters: read up to ~300KB.
    const reader = r.body!.getReader();
    let html = "";
    const dec = new TextDecoder();
    while (html.length < 300_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    void reader.cancel().catch(() => {});
    const title = meta(html, ["og:title", "twitter:title"]) ?? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "");
    const image = meta(html, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
    const icon = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1];
    const base = new URL(r.url || url);
    if (title || image)
      v = {
        url,
        title: title || base.hostname,
        description: meta(html, ["og:description", "twitter:description", "description"])?.slice(0, 300),
        image: image ? new URL(image, base).toString() : undefined,
        site: meta(html, ["og:site_name"]) ?? base.hostname.replace(/^www\./, ""),
        icon: new URL(icon ?? "/favicon.ico", base).toString(),
      };
  } catch {}
  cache.set(url, { at: Date.now(), v });
  return v;
}
