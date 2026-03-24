/**
 * Phase 1: Prompt leak audit scanner.
 *
 * Detects lines in generated screenplay output that look like internal prompt
 * scaffolding/meta instructions leaking into user-visible script text.
 *
 * Usage:
 *   node promptLeakAudit.js --file "path/to/script12.txt"
 *   node promptLeakAudit.js --input "path/to/fixtures"
 */

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

const DEFAULT_PATTERNS = [
  { key: "prev_episode_tail_marker", re: /END\s+OF\s+PREVIOUS\s+EPISODE/i },
  { key: "write_episode_instruction", re: /\bWrite\s+episode\s+\d+\s+now\b/i },
  { key: "continuing_directly_instruction", re: /\bcontinuing\s+directly\b/i },
  { key: "line_spacing_separator_instruction", re: /\bline\s+spacing\s+separator\b/i },
  { key: "marking_transition_instruction", re: /\bmarking\s+transition\b/i },
  { key: "meta_output_instruction", re: /\bOutput\s+only\b.*\b(script|screenplay|content)\b/i },
  { key: "do_not_output_instruction", re: /\bDo\s+NOT\s+output\b/i },
  { key: "character_manifest_instruction", re: /\bCHARACTER\s+MANIFEST\b/i },
  { key: "continuation_requirement_instruction", re: /\bCONTINUATION\s+REQUIREMENT\b/i },
  { key: "prompt_boundary_marker", re: /---\s*END\s+OF\s+.*EPISODE.*---/i },
  { key: "messy_dash_episode_divider", re: /^\s*-{2,}\s*EP(?:ISODE|OSODE|ISDE|ODES?)\s*\d+/i },
  { key: "dash_number_noise", re: /^\s*(?:-\d+\s+){2,}EP(?:ISODE|OSODE|ISDE|ODES?)\s*\d+/i },
];

function detectEpisodeNumber(line, currentEpisode) {
  const m = String(line || "").match(/^\s*EP(?:ISODE|OSODE|ISDE|ODES?)\s+(\d+)\b/i);
  if (!m) return currentEpisode;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : currentEpisode;
}

export function auditPromptLeaks(text, options = {}) {
  const input = String(text || "");
  const patterns = Array.isArray(options.patterns) && options.patterns.length
    ? options.patterns
    : DEFAULT_PATTERNS;

  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const findings = [];
  const byPattern = new Map();
  const byEpisode = new Map();

  let currentEpisode = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentEpisode = detectEpisodeNumber(line, currentEpisode);
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const p of patterns) {
      if (!p || !p.re || !p.key) continue;
      if (!p.re.test(trimmed)) continue;

      const row = {
        line: i + 1,
        episode: currentEpisode,
        pattern: p.key,
        text: trimmed.slice(0, 240),
      };
      findings.push(row);

      byPattern.set(p.key, (byPattern.get(p.key) || 0) + 1);
      const epKey = currentEpisode == null ? "unknown" : String(currentEpisode);
      byEpisode.set(epKey, (byEpisode.get(epKey) || 0) + 1);
      break;
    }
  }

  return {
    totals: {
      lines: lines.length,
      leakCount: findings.length,
      uniquePatterns: byPattern.size,
      episodesImpacted: byEpisode.size,
    },
    countsByPattern: Object.fromEntries([...byPattern.entries()].sort((a, b) => b[1] - a[1])),
    countsByEpisode: Object.fromEntries(
      [...byEpisode.entries()].sort((a, b) => {
        if (a[0] === "unknown") return 1;
        if (b[0] === "unknown") return -1;
        return Number(a[0]) - Number(b[0]);
      })
    ),
    findings,
  };
}

export function formatPromptLeakAudit(report, maxRows = 80) {
  const lines = [];
  lines.push("Prompt leak audit report");
  lines.push(`- leakCount: ${report.totals.leakCount}`);
  lines.push(`- uniquePatterns: ${report.totals.uniquePatterns}`);
  lines.push(`- episodesImpacted: ${report.totals.episodesImpacted}`);

  lines.push("");
  lines.push("Counts by pattern:");
  for (const [k, v] of Object.entries(report.countsByPattern || {})) {
    lines.push(`- ${k}: ${v}`);
  }

  lines.push("");
  lines.push("Counts by episode:");
  for (const [k, v] of Object.entries(report.countsByEpisode || {})) {
    lines.push(`- episode ${k}: ${v}`);
  }

  const rows = Array.isArray(report.findings) ? report.findings.slice(0, maxRows) : [];
  if (rows.length) {
    lines.push("");
    lines.push("Sample findings:");
    for (const r of rows) {
      const ep = r.episode == null ? "unknown" : r.episode;
      lines.push(`- line ${r.line}, ep ${ep}, ${r.pattern}: ${r.text}`);
    }
  }

  return lines.join("\n");
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = args.input ? path.resolve(String(args.input)) : null;
  const inputFile = args.file ? path.resolve(String(args.file)) : null;
  const jsonMode = args.json === true;

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
    const report = auditPromptLeaks(raw);
    if (report.totals.leakCount > 0) failed += 1;

    console.log(`\n=== ${path.basename(filePath)} ===`);
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatPromptLeakAudit(report, 60));
    }
    console.log(report.totals.leakCount > 0 ? "LEAKS_FOUND" : "CLEAN");
  }

  process.exit(failed ? 1 : 0);
}

if (process.argv.length > 2) {
  runCli();
}

