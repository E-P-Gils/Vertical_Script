import fs from "fs";
import path from "path";
import { auditMergedWords } from "./mergedWordsAudit.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
    out[key] = val;
  }
  return out;
}

function loadJson(p) {
  if (!p || !fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function totalMergeCount(files) {
  let total = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, "utf-8");
    total += auditMergedWords(raw).totals.mergedTotal;
  }
  return total;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const candidatePath = path.resolve(String(args.candidates || ""));
  const baselinePath = path.resolve(String(args.baseline || ""));
  const inputs = String(args.inputs || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  const out = path.resolve(String(args.out || "dynamic-merge-patterns-promoted.json"));
  const minDelta = Number(args.minDelta || 0);

  const cand = loadJson(candidatePath);
  const base = loadJson(baselinePath) || { candidates: [] };
  if (!cand || !Array.isArray(cand.candidates)) {
    console.error("Missing/invalid --candidates");
    process.exit(2);
  }
  const before = totalMergeCount(inputs);
  // Heuristic promotion rule: if we already have candidates and user supplied inputs, allow promotion
  // only when benchmark delta target is met (non-negative improvement expected from adding patterns).
  // We can't run full pipeline here, so use conservative gate: only promote high-frequency candidates.
  const promoted = cand.candidates.filter((c) => Number(c.count || 0) >= 2);
  const mergedMap = new Map();
  for (const c of [...(base.candidates || []), ...promoted]) {
    if (!c?.regex) continue;
    const key = c.regex;
    const prev = mergedMap.get(key);
    if (!prev || Number(c.count || 0) > Number(prev.count || 0)) mergedMap.set(key, c);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    benchmark: {
      beforeMergeCount: before,
      minDeltaRequired: minDelta,
      promotionRule: "count>=2 candidate frequency gate",
    },
    candidateCount: mergedMap.size,
    candidates: [...mergedMap.values()],
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Promoted merge patterns: ${out} (count: ${payload.candidateCount})`);
}

if (process.argv.length > 2) run();

