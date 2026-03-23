/**
 * Phase 3 regression runner for merged-word issues.
 *
 * Usage:
 *   node runMergedWordsRegression.js --input "path/to/fixtures" --threshold 3
 * or:
 *   node runMergedWordsRegression.js --file "path/to/episode.txt" --threshold 3
 */

import fs from "fs";
import path from "path";
import { auditMergedWords, formatAuditReport } from "./mergedWordsAudit.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const threshold = Number(args.threshold ?? 3);

const inputDir = args.input ? path.resolve(String(args.input)) : null;
const inputFile = args.file ? path.resolve(String(args.file)) : null;

let files = [];
if (inputFile) {
  files = [inputFile];
} else if (inputDir && fs.existsSync(inputDir)) {
  const entries = fs.readdirSync(inputDir, { withFileTypes: true });
  files = entries
    .filter((e) => e.isFile())
    .map((e) => path.join(inputDir, e.name))
    .filter((p) => /\.(txt|md)$/i.test(p));
} else {
  console.error("Missing --input or --file.");
  process.exit(2);
}

let failed = 0;
for (const filePath of files) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const report = auditMergedWords(raw);
  const ok = report.totals.mergedTotal <= threshold;
  if (!ok) failed += 1;

  console.log(`\n=== ${path.basename(filePath)} ===`);
  console.log(formatAuditReport(report, 10));
  console.log(ok ? "PASS" : `FAIL (mergedTotal > ${threshold})`);
}

process.exit(failed ? 1 : 0);

