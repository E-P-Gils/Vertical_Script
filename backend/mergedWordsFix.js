/**
 * Phase B: deterministic merge normalizer v2
 * Ordered, idempotent subpasses with per-pass metrics.
 */

const DEFAULT_WHITELIST_PREFIXES = ["INT.", "EXT.", "INT/EXT.", "EXT/INT.", "V.O.", "O.S.", "CONT'D", "MC"];

const LOWER_GLUE_FIXES = [
  [/\btogetherjust\b/gi, "together just"],
  [/\bforwardgrabbing\b/gi, "forward grabbing"],
  [/\bbeforeturning\b/gi, "before turning"],
  [/\bturningquickly\b/gi, "turning quickly"],
  [/\bquicklytowardsthe\b/gi, "quickly towards the"],
  [/\btowardsthe\b/gi, "towards the"],
  [/\bthelobby\b/gi, "the lobby"],
  [/\benteringthe\b/gi, "entering the"],
  [/\bnearbythe\b/gi, "nearby the"],
];

function shouldSkipBoundaryAt(line, matchIndexOfLeftChar, whitelistPrefixes) {
  const rightSlice = line.slice(matchIndexOfLeftChar + 1, matchIndexOfLeftChar + 1 + 14);
  return whitelistPrefixes.some((p) => rightSlice.startsWith(p));
}

function applyRegexWithCount(text, re, replacementFnOrText) {
  let count = 0;
  const out = String(text || "").replace(re, (...args) => {
    count += 1;
    return typeof replacementFnOrText === "function"
      ? replacementFnOrText(...args)
      : replacementFnOrText;
  });
  return { text: out, count };
}

function expandCanonicalNames(characterNames = []) {
  const out = new Set();
  for (const name of characterNames) {
    const raw = String(name || "").trim();
    if (!raw) continue;
    out.add(raw);
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts[0]) out.add(parts[0]);
    if (parts.length > 1) out.add(parts[parts.length - 1]);
  }
  return [...out];
}

export function fixMergedWordIssuesPhase2Detailed(text, options = {}) {
  const whitelistPrefixes = options.whitelistPrefixes || DEFAULT_WHITELIST_PREFIXES;
  const logs = [];
  let t = String(text || "");

  // 1) clause boundary lower->Upper
  const lines = t.split(/\r?\n/);
  let clauseCount = 0;
  t = lines
    .map((line) => {
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = line[i + 1];
        if (ch && next && /[a-z]/.test(ch) && /[A-Z]/.test(next)) {
          if (shouldSkipBoundaryAt(line, i, whitelistPrefixes)) {
            out += ch + next;
            i += 1;
            continue;
          }
          out += ch + " " + next;
          clauseCount += 1;
          i += 1;
          continue;
        }
        out += ch;
      }
      return out;
    })
    .join("\n");
  logs.push({ rule: "clause_boundary", count: clauseCount });

  // 2) lower-lower glue token pass
  let lowerGlueCount = 0;
  for (const [re, rep] of LOWER_GLUE_FIXES) {
    const res = applyRegexWithCount(t, re, rep);
    t = res.text;
    lowerGlueCount += res.count;
  }
  logs.push({ rule: "lower_glue_tokens", count: lowerGlueCount });
  // 2b) dynamic registry patterns
  let dynamicCount = 0;
  const dynamicPatterns = Array.isArray(options.dynamicPatterns) ? options.dynamicPatterns : [];
  for (const re of dynamicPatterns) {
    const res = applyRegexWithCount(t, re, (m) => {
      // conservative split attempt: only when token appears glued
      return String(m).replace(/([a-z])([A-Z])/g, "$1 $2");
    });
    t = res.text;
    dynamicCount += res.count;
  }
  logs.push({ rule: "dynamic_registry_patterns", count: dynamicCount });

  // 3) canonical-name action glue
  let nameGlueCount = 0;
  const names = expandCanonicalNames(options.characterNames || []);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b(${escaped})([a-z]{2,})\\b`, "gi");
    const res = applyRegexWithCount(t, re, (_m, a, b) => `${a} ${b}`);
    t = res.text;
    nameGlueCount += res.count;
  }
  logs.push({ rule: "canonical_name_action_glue", count: nameGlueCount });

  // 4) chained phrase split fallback
  const chained = applyRegexWithCount(
    t,
    /\b([a-z]{4,})(just|then|but|while|when|before|after|into|onto|towards|toward)\b/g,
    (_m, a, b) => `${a} ${b}`
  );
  t = chained.text;
  logs.push({ rule: "chained_phrase_split", count: chained.count });

  // 5) structural marker separation
  const b1 = applyRegexWithCount(
    t,
    /([^\n])\s*((?:END\s+(?:OF\s+)?EPISODE\s+\d+|FADE\s+IN|FADE\s+OUT|CUT\s+TO|SMASH\s+CUT)\b)/gi,
    (_m, a, b) => `${a}\n${b}`
  );
  t = b1.text;
  const b2 = applyRegexWithCount(
    t,
    /((?:END\s+(?:OF\s+)?EPISODE\s+\d+|FADE\s+IN|FADE\s+OUT|CUT\s+TO|SMASH\s+CUT)\b)\s*([^\n])/gi,
    (_m, a, b) => `${a}\n${b}`
  );
  t = b2.text;
  logs.push({ rule: "structural_marker_separation", count: b1.count + b2.count });

  // idempotence checksum helper (cheap): rerun once and count residual delta
  const rerun = String(t)
    .replace(/\b([a-z]{4,})(just|then|but|while|when|before|after|into|onto|towards|toward)\b/g, "$1 $2")
    .replace(/([^\n])\s*((?:END\s+(?:OF\s+)?EPISODE\s+\d+|FADE\s+IN|FADE\s+OUT|CUT\s+TO|SMASH\s+CUT)\b)/gi, "$1\n$2")
    .replace(/((?:END\s+(?:OF\s+)?EPISODE\s+\d+|FADE\s+IN|FADE\s+OUT|CUT\s+TO|SMASH\s+CUT)\b)\s*([^\n])/gi, "$1\n$2");
  const idempotent = rerun === t;
  logs.push({ rule: "idempotence_check", count: idempotent ? 0 : 1 });

  return { text: t, logs, idempotent };
}

export function fixMergedWordIssuesPhase2(text, options = {}) {
  return fixMergedWordIssuesPhase2Detailed(text, options).text;
}

