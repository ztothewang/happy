import { useEffect, useMemo, useState } from "react";
import { fileUrl } from "./pane";

/** Spreadsheets Happy shows as tables (desktop pane and phone file view). */
export const isSheetPath = (p: string) => /\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv)$/i.test(p);

const MAX_ROWS = 2000;
const MAX_COLS = 60;

type Sheet = { name: string; rows: string[][]; totalRows: number; totalCols: number };

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Excel / CSV as a scrollable grid with sheet tabs (SheetJS, loaded on first use). */
export function SheetView({ path, v }: { path: string; v?: number }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [err, setErr] = useState<string>();
  const [tab, setTab] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setErr(undefined);
    setTab(0);
    void (async () => {
      const XLSX = await import("xlsx");
      const res = await fetch(fileUrl(path, v));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csv = /\.(csv|tsv)$/i.test(path);
      const wb = csv
        ? XLSX.read((await res.text()).replace(/^\uFEFF/, ""), { type: "string", FS: /\.tsv$/i.test(path) ? "\t" : undefined, raw: true })
        : XLSX.read(await res.arrayBuffer(), { type: "array", cellDates: true, dense: true });
      const out: Sheet[] = wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name];
        const all = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "", blankrows: false });
        const totalCols = all.reduce((m, r) => Math.max(m, r.length), 0);
        return { name, totalRows: all.length, totalCols, rows: all.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((c) => String(c ?? ""))) };
      });
      if (!cancelled) setSheets(out);
    })().catch((e) => !cancelled && setErr(String((e as Error).message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [path, v]);

  const sheet = sheets?.[tab];
  const cols = useMemo(() => Math.min(sheet?.totalCols ?? 0, MAX_COLS), [sheet]);

  if (err) return <div className="muted pad small">Couldn't read this spreadsheet ({err}).</div>;
  if (!sheets) return <div className="muted pad center mono small">loading…</div>;
  return (
    <div className="sheet">
      {sheets.length > 1 && (
        <div className="sheet-tabs">
          {sheets.map((s, i) => (
            <button key={s.name} className={i === tab ? "on" : ""} onClick={() => setTab(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet && (
        <>
          <div className="sheet-grid">
            <table>
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: cols }, (_, i) => (
                    <th key={i}>{colName(i)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((r, ri) => (
                  <tr key={ri}>
                    <th>{ri + 1}</th>
                    {Array.from({ length: cols }, (_, ci) => (
                      <td key={ci} title={r[ci] && r[ci].length > 40 ? r[ci] : undefined}>
                        {r[ci] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(sheet.totalRows > MAX_ROWS || sheet.totalCols > MAX_COLS) && (
            <div className="muted small sheet-more">
              showing {Math.min(sheet.totalRows, MAX_ROWS).toLocaleString()} of {sheet.totalRows.toLocaleString()} rows
              {sheet.totalCols > MAX_COLS ? ` · ${MAX_COLS} of ${sheet.totalCols} columns` : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}
