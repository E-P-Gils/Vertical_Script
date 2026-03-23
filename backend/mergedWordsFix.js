/**
 * Phase 2 (targeted normalisation):
 * - Fix lowercase→uppercase merges by inserting a space, except when whitelisted.
 * - Separately fix the END EPISODE newline swallow bug.
 */

const DEFAULT_WHITELIST_PREFIXES = [
  "INT.",
  "EXT.",
  "INT/EXT.",
  "EXT/INT.",
  "V.O.",
  "O.S.",
  "CONT'D",
];

function shouldSkipBoundaryAt(line, matchIndexOfLeftChar, whitelistPrefixes) {
  const rightSlice = line.slice(matchIndexOfLeftChar + 1, matchIndexOfLeftChar + 1 + 14);
  return whitelistPrefixes.some((p) => rightSlice.startsWith(p));
}

export function fixLowerUpperBoundaryMerges(text, options = {}) {
  const input = String(text || "");
  const whitelistPrefixes = options.whitelistPrefixes || DEFAULT_WHITELIST_PREFIXES;

  // Replace on a per-line basis to keep reasoning about context simple.
  const lines = input.split(/\r?\n/);
  const fixed = lines.map((line) => {
    // We use a manual scan so we can inspect per-match context (whitelist).
    let out = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch && next && /[a-z]/.test(ch) && /[A-Z]/.test(next)) {
        // If next begins a whitelisted tag, do not insert a space.
        if (shouldSkipBoundaryAt(line, i, whitelistPrefixes)) {
          out += ch + next;
          i += 1;
          continue;
        }
        out += ch + " " + next;
        i += 1;
        continue;
      }
      out += ch;
    }
    return out;
  });

  return fixed.join("\n");
}

/**
 * Patch “END EPISODE N” swallow bug:
 * Ensure END EPISODE N always appears on its own line with a line break before it.
 */
export function fixEndEpisodeNewlines(text) {
  let t = String(text || "");

  // Normalize marker wording but do not remove it (other pipeline steps may strip it).
  t = t.replace(/END\s+EPISODE\s+(\d+)/gi, "END OF EPISODE $1");

  // Ensure newline before marker if glued to previous char.
  t = t.replace(/([^\n])\s*(END OF EPISODE\s+\d+)/gi, "$1\n$2");
  // Ensure newline after marker if glued to next char.
  t = t.replace(/(END OF EPISODE\s+\d+)\s*([^\n])/gi, "$1\n$2");

  return t;
}

export function fixMergedWordIssuesPhase2(text, options = {}) {
  // Sequentially (Phase 2 requirement): do NOT run simultaneously.
  let t = fixLowerUpperBoundaryMerges(text, options);
  t = fixEndEpisodeNewlines(t);
  return t;
}

