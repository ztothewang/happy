import { Download, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { baseName, fileUrl } from "../pane";

type PdfDoc = { numPages: number; getPage(n: number): Promise<any>; destroy(): void };

/**
 * PDFs on the phone: pages drawn with pdf.js into a scrollable column (iOS won't scroll or zoom a PDF in an iframe).
 * Pinch or +/− zooms; Save hands the file to the share sheet (Save to Files, AirDrop…).
 */
export function PdfView({ path }: { path: string }) {
  const box = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [err, setErr] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const pinch = useRef(1);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      const data = await fetch(fileUrl(path)).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      loaded = (await pdfjs.getDocument({ data }).promise) as unknown as PdfDoc;
      if (cancelled) loaded.destroy();
      else setDoc(loaded);
    })().catch((e) => !cancelled && setErr(String((e as Error).message ?? e)));
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [path]);

  // (Re)draw every page at the current zoom, sharp for the screen's pixel ratio.
  useEffect(() => {
    if (!doc || !box.current || !pages.current) return;
    let stop = false;
    const width = (box.current.clientWidth - 2) * zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const host = pages.current;
    host.style.transform = "";
    void (async () => {
      for (let n = 1; n <= doc.numPages && !stop; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (width / base.width) * dpr });
        const c = document.createElement("canvas");
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        c.style.width = `${Math.floor(width)}px`;
        c.style.height = `${Math.floor(vp.height / dpr)}px`;
        if (n === 1) host.replaceChildren(c);
        else host.appendChild(c);
        await page.render({ canvasContext: c.getContext("2d")!, viewport: vp, canvas: c }).promise;
      }
    })().catch(() => {});
    return () => {
      stop = true;
    };
  }, [doc, zoom]);

  // iOS pinch: preview with a CSS scale while pinching, redraw at the new zoom when the fingers lift.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const start = (e: Event) => {
      e.preventDefault();
      pinch.current = 1;
    };
    const change = (e: Event) => {
      e.preventDefault();
      pinch.current = (e as unknown as { scale: number }).scale;
      if (pages.current) pages.current.style.transform = `scale(${pinch.current})`;
    };
    const end = (e: Event) => {
      e.preventDefault();
      setZoom((z) => clampZoom(z * pinch.current));
    };
    el.addEventListener("gesturestart", start);
    el.addEventListener("gesturechange", change);
    el.addEventListener("gestureend", end);
    return () => {
      el.removeEventListener("gesturestart", start);
      el.removeEventListener("gesturechange", change);
      el.removeEventListener("gestureend", end);
    };
  }, []);

  const save = async () => {
    try {
      const blob = await fetch(fileUrl(path)).then((r) => r.blob());
      const file = new File([blob], baseName(path), { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) return void (await navigator.share({ files: [file] }));
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: baseName(path) });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {}
  };

  return (
    <div className="mx-pdf">
      <div className="mx-pdf-bar">
        <span>{doc ? `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}` : err ? "" : "loading…"}</span>
        <button aria-label="Zoom out" onClick={() => setZoom((z) => clampZoom(z / 1.25))}>
          <Minus size={16} />
        </button>
        <button className="mx-pdf-pct" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button aria-label="Zoom in" onClick={() => setZoom((z) => clampZoom(z * 1.25))}>
          <Plus size={16} />
        </button>
        <button aria-label="Save" onClick={() => void save()}>
          <Download size={16} /> Save
        </button>
      </div>
      <div className="mx-pdf-pages" ref={box}>
        {err ? <div className="mx-muted">Couldn't open this PDF ({err}).</div> : <div ref={pages} className="mx-pdf-col" />}
      </div>
    </div>
  );
}

const clampZoom = (z: number) => Math.min(4, Math.max(0.5, z));
