import fs from "fs";
import path from "path";

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

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(line) {
  return String(line || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function looksLikeMergeLine(line) {
  const t = String(line || "").trim();
  return /[a-z][A-Z]/.test(t) || /\b[a-z]{4,}(just|then|but|while|when|before|after|towards|toward)\b/.test(t);
}

function mineFromText(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const counts = new Map();
  for (const line of lines) {
    if (!looksLikeMergeLine(line)) continue;
    const n = normalize(line);
    if (!n || n.length < 8) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return [...counts.entries()].map(([n, c]) => ({
    regex: escapeRegExp(n).replace(/\s+/g, "\\s+"),
    count: c,
    sample: n.slice(0, 220),
  }));
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = String(args.inputs || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  const out = path.resolve(String(args.out || "dynamic-merge-patterns.json"));
  if (!inputs.length) {
    console.error("Missing --inputs");
    process.exit(2);
  }
  const all = [];
  for (const f of inputs) {
    if (!fs.existsSync(f)) continue;
    const mined = mineFromText(fs.readFileSync(f, "utf-8"));
    for (const m of mined) all.push({ ...m, source: path.basename(f) });
  }
  const merged = new Map();
  for (const r of all) {
    const prev = merged.get(r.regex);
    if (!prev || r.count > prev.count) merged.set(r.regex, r);
  }
  const candidates = [...merged.values()].sort((a, b) => b.count - a.count);
  const payload = { generatedAt: new Date().toISOString(), candidateCount: candidates.length, candidates };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Wrote merge pattern candidates: ${out} (count: ${candidates.length})`);
}

if (process.argv.length > 2) run();

