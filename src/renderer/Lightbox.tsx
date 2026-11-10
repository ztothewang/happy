import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { LinkPreview } from "../shared/types";
import { hub } from "./App";
import { usePane } from "./pane";
import { useLinkMenu } from "./linkMenu";

/** Open an image (any URL: hubfile, /hubfile, https, data) full size over the app. */
export const openLightbox = (src: string) => window.dispatchEvent(new CustomEvent("happy:lightbox", { detail: src }));

/** The image viewer: mounted once at the root (desktop and phone). Esc or a click outside the image closes it. */
export function Lightbox() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setSrc((e as CustomEvent<string>).detail);
    window.addEventListener("happy:lightbox", on);
    return () => window.removeEventListener("happy:lightbox", on);
  }, []);
  useEffect(() => {
    if (!src) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setSrc(null));
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [src]);
  if (!src) return null;
  return (
    <div className="lightbox" onClick={() => setSrc(null)}>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
      <button className="lb-x" aria-label="Close" onClick={() => setSrc(null)}>
        <X size={18} />
      </button>
    </div>
  );
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;
export const linksIn = (text?: string) => [...new Set(text?.match(URL_RE) ?? [])].slice(0, 3);

function LinkCard({ url }: { url: string }) {
  const pane = usePane();
  const linkMenu = useLinkMenu();
  const [p, setP] = useState<LinkPreview | null | undefined>(undefined);
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => {
    let alive = true;
    void hub()
      .linkPreview(url)
      .then((v) => alive && setP(v))
      .catch(() => alive && setP(null));
    return () => void (alive = false);
  }, [url]);
  if (!p) return null;
  return (
    <button className="link-card" data-url={url} onClick={() => pane.openLink(url)} onContextMenu={(e) => linkMenu(e, url)}>
      {p.image && imgOk && <img className="lc-img" src={p.image} alt="" loading="lazy" onError={() => setImgOk(false)} />}
      <span className="lc-text">
        <span className="lc-site">
          {p.icon && <img src={p.icon} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
          {p.site}
        </span>
        <b>{p.title}</b>
        {p.description && <span className="lc-desc">{p.description}</span>}
      </span>
    </button>
  );
}

/** Preview cards for the links in a message (title, description, image), like Slack/iMessage unfurls. */
export function LinkCards({ text }: { text?: string }) {
  const urls = linksIn(text);
  if (!urls.length) return null;
  return (
    <div className="link-cards">
      {urls.map((u) => (
        <LinkCard key={u} url={u} />
      ))}
    </div>
  );
}
