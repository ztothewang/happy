export type DiffOp = { type: "same" | "add" | "del"; text: string; a?: number; b?: number };

/** Line diff via LCS. Falls back to delete-all/add-all for very large inputs. */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // Trim common prefix/suffix to keep the DP small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "same", text: a[i], a: i + 1, b: i + 1 });

  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > 4_000_000) {
    ma.forEach((t, i) => ops.push({ type: "del", text: t, a: start + i + 1 }));
    mb.forEach((t, i) => ops.push({ type: "add", text: t, b: start + i + 1 }));
  } else {
    const n = ma.length;
    const m = mb.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = ma[i] === mb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        ops.push({ type: "same", text: ma[i], a: start + i + 1, b: start + j + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        ops.push({ type: "add", text: mb[j], b: start + j + 1 });
        j++;
      } else {
        ops.push({ type: "del", text: ma[i], a: start + i + 1 });
        i++;
      }
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ type: "same", text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });
  return ops;
}

/** Parse a unified git diff into display rows. */
export function parseUnified(diff: string): DiffOp[] {
  const out: DiffOp[] = [];
  let a = 0;
  let b = 0;
  for (const line of diff.split("\n")) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      out.push({ type: "same", text: `@@ ${h[3].trim()}` });
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith("+")) out.push({ type: "add", text: line.slice(1), b: b++ });
    else if (line.startsWith("-")) out.push({ type: "del", text: line.slice(1), a: a++ });
    else if (line.startsWith(" ")) out.push({ type: "same", text: line.slice(1), a: a++, b: b++ });
  }
  return out;
}

/** Collapse long unchanged runs, keeping `ctx` lines of context around changes. */
export function withContext(ops: DiffOp[], ctx = 4): Array<DiffOp | { type: "gap"; count: number }> {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.type !== "same" || o.text.startsWith("@@")) for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++) keep[k] = true;
  });
  const out: Array<DiffOp | { type: "gap"; count: number }> = [];
  let gap = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (gap) out.push({ type: "gap", count: gap });
      gap = 0;
      out.push(o);
    } else gap++;
  });
  if (gap) out.push({ type: "gap", count: gap });
  return out;
}
