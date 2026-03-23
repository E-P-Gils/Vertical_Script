/**
 * Merged-words audit: detects lowercase→uppercase word-boundary merges (e.g. "watchedTrevor")
 * and other glue tokens we commonly see.
 *
 * This is Phase 1 (audit + categorized report) and is also usable as a quality gate.
 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DEFAULT_WHITELIST_PREFIXES = [
  // Screenplay formatting tags / abbreviations that may touch preceding words in bad generations.
  "INT.",
  "EXT.",
  "INT/EXT.",
  "EXT/INT.",
  "V.O.",
  "O.S.",
  "CONT'D",
  "CONT'D)",
  "FADE",
  "CUT",
  "DISSOLVE",
  "EPISODE",
  "END",
  "ONSCREEN",
];

const DEFAULT_CONNECTOR_GLUE_TOKENS = [
  // These are not caught by [a-z][A-Z], but they are common real failures in your content.
  "enteringthe",
  "nearbythe",
  "sharplyand",
  "closeragainabout",
  "closeragain",
  "againabout",
  "togetherthen",
  "Lucasthis",
  "stiffensher",
  "herselfconsciously",
  "someoneelse",
  "withoutwarning",
  "frombehind",
  "elsein",
  "dresseda",
  "toithis",
  "forithis",
  "histhere's",
];

export function auditMergedWords(text, options = {}) {
  const input = String(text || "");
  const whitelistPrefixes = options.whitelistPrefixes || DEFAULT_WHITELIST_PREFIXES;
  const connectorTokens = options.connectorTokens || DEFAULT_CONNECTOR_GLUE_TOKENS;

  const boundaryRe = /([a-z])([A-Z])/g;
  const boundaryWhitelist = whitelistPrefixes
    .map((p) => (p.endsWith(".") ? p : p))
    .filter(Boolean);

  const boundaryMatches = [];
  const connectorMatches = [];

  const lines = input.split(/\r?\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (!line) continue;

    // 1) lowercase→uppercase adjacency
    boundaryRe.lastIndex = 0;
    let m;
    while ((m = boundaryRe.exec(line)) !== null) {
      const start = m.index; // index of the lowercase char
      const left = m[1];
      const right = m[2];
      const rightSlice = line.slice(start + 1, start + 1 + 14); // up to 14 chars ahead

      const isWhitelisted = boundaryWhitelist.some((prefix) => {
        // Compare case-sensitively for the expected tokens (they're typically uppercase).
        return rightSlice.startsWith(prefix);
      });

      boundaryMatches.push({
        line: lineIdx + 1,
        col: start + 1, // 1-based
        left,
        right,
        rightSlice,
        category: isWhitelisted ? "whitelisted" : "true_merge",
      });
    }

    // 2) connector glue tokens (exact tokens, case-insensitive)
    for (const tok of connectorTokens) {
      if (!tok) continue;
      const re = new RegExp(escapeRegExp(tok), "gi");
      let cm;
      while ((cm = re.exec(line)) !== null) {
        connectorMatches.push({
          line: lineIdx + 1,
          col: cm.index + 1,
          token: tok,
          category: "known_glue",
        });
      }
    }
  }

  const trueMergeCount = boundaryMatches.filter((x) => x.category === "true_merge")
    .length;
  const whitelistCount = boundaryMatches.filter((x) => x.category === "whitelisted").length;
  const connectorCount = connectorMatches.length;

  return {
    totals: {
      boundaryLowerUpper: boundaryMatches.length,
      trueMergeCount,
      whitelistCount,
      connectorGlueCount: connectorCount,
      mergedTotal: trueMergeCount + connectorCount,
    },
    boundaryMatches,
    connectorMatches,
  };
}

export function formatAuditReport(report, maxItems = 30) {
  const lines = [];
  lines.push(`Merged-word audit report`);
  lines.push(`- mergedTotal: ${report.totals.mergedTotal}`);
  lines.push(`- true_lowerUpper_merges: ${report.totals.trueMergeCount}`);
  lines.push(`- whitelisted_lowerUpper_merges: ${report.totals.whitelistCount}`);
  lines.push(`- known_connector_glue_tokens: ${report.totals.connectorGlueCount}`);

  const topBoundary = report.boundaryMatches
    .filter((x) => x.category === "true_merge")
    .slice(0, maxItems);
  if (topBoundary.length) {
    lines.push("");
    lines.push("First true lower→Upper merge instances:");
    for (const x of topBoundary) {
      lines.push(`- line ${x.line}:${x.col}: '${x.left}${x.right}' next='${x.rightSlice}'`);
    }
  }

  const topConnector = report.connectorMatches.slice(0, maxItems);
  if (topConnector.length) {
    lines.push("");
    lines.push("Known connector glue instances:");
    for (const x of topConnector) {
      lines.push(`- line ${x.line}:${x.col}: token '${x.token}'`);
    }
  }

  return lines.join("\n");
}

// ---------------- CLI ----------------
// node mergedWordsAudit.js --input path/to/file.txt
if (import.meta.url && process.argv && process.argv[1] && process.argv.length > 2) {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  if (inputIdx >= 0 && args[inputIdx + 1]) {
    const fs = await import("fs");
    const path = await import("path");
    const filePath = path.resolve(args[inputIdx + 1]);
    const raw = fs.readFileSync(filePath, "utf-8");
    const report = auditMergedWords(raw);
    // eslint-disable-next-line no-console
    console.log(formatAuditReport(report));
  }
}

