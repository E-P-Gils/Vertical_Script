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
  // High-frequency from scripts 12–24 (ly‑adverb + glue)
  [/\binstinctivelybut\b/gi, "instinctively but"],
  [/\binstinctivelyand\b/gi, "instinctively and"],
  [/\binstinctivelyto\b/gi, "instinctively to"],
  [/\binstinctivelyher\b/gi, "instinctively her"],
  [/\binstinctivelythe\b/gi, "instinctively the"],
  [/\bsimultaneouslybut\b/gi, "simultaneously but"],
  [/\bsimultaneouslyand\b/gi, "simultaneously and"],
  [/\bsimultaneouslyto\b/gi, "simultaneously to"],
  [/\bdeliberatelywith\b/gi, "deliberately with"],
  [/\bdeliberatelyhis\b/gi, "deliberately his"],
  [/\bdeliberatelyher\b/gi, "deliberately her"],
  [/\bsuddenlyeverything\b/gi, "suddenly everything"],
  [/\bsuddenlyand\b/gi, "suddenly and"],
  [/\bsuddenlythe\b/gi, "suddenly the"],
  [/\beffortlesslyand\b/gi, "effortlessly and"],
  [/\bprofessionaland\b/gi, "professional and"],
  [/\bprofessionalthere\b/gi, "professional there"],
  [/\btonightincluding\b/gi, "tonight including"],
  [/\btonightaccusations\b/gi, "tonight accusations"],
  [/\bgroundexclusive\b/gi, "ground exclusive"],
  [/\binstantlygrabbing\b/gi, "instantly grabbing"],
  [/\binstantlyturning\b/gi, "instantly turning"],
  [/\bheeldisappearing\b/gi, "heel disappearing"],
  [/\bcorridorleaving\b/gi, "corridor leaving"],
  [/\bstreetlighttheir\b/gi, "streetlight their"],
];

/** Real words that must not be split by the chained glue pass (e.g. thous+and). */
const CHAINED_SPLIT_DENYLIST = new Set(
  `
  thousand understand expand island strand weekend boyfriend girlfriend fiance fiancee
  together altogether feather heather leather weather whether brother mother another
  forthwith notwithstanding demand command remand offend attend contend descend intend
  amend append defend depend expend extend legend portend pretend transcend
  correspond despond respond shepherd leopard
  lathe tithe scythe writhe
  `
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
);

const CHAINED_GLUE_SUFFIXES =
  "just|then|but|and|the|her|his|to|with|for|not|now|yet|so|" +
  "while|when|before|after|into|onto|towards|toward|something|" +
  "leaving|grabbing|turning|including|especially|because|although";

const CHAINED_PHRASE_RE = new RegExp(`\\b([a-z]{4,})(${CHAINED_GLUE_SUFFIXES})\\b`, "g");

const LONG_KNOWN_LOWERCASE_WORDS = new Set(
  `
  straightforward responsibilities professionalism simultaneously instantaneously
  uncharacteristically extraordinarily environmentally comprehensively
  transportation infrastructure
  `
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
);

function shouldSkipBoundaryAt(line, matchIndexOfLeftChar, whitelistPrefixes) {
  const rightSlice = line.slice(matchIndexOfLeftChar + 1, matchIndexOfLeftChar + 1 + 14);
  return whitelistPrefixes.some((p) => rightSlice.startsWith(p));
}

function isSceneHeadingLine(trimmed) {
  return (
    /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(trimmed) ||
    /^EPISODE\s+\d/i.test(trimmed) ||
    /^(FADE\b|CUT\b|DISSOLVE\b|SMASH\s+CUT\b)/i.test(trimmed)
  );
}

/** True for a typical screenplay character cue (ALL CAPS, optional parenthetical). */
function isScreenplayCharacterCue(trimmed) {
  const s = String(trimmed || "").trim();
  if (!s || s.length > 52) return false;
  if (/^(EPISODE|END\b)/i.test(s)) return false;
  if (isSceneHeadingLine(s)) return false;
  const paren = s.match(/^([A-Z0-9][A-Z0-9\s\-'.]{0,40})(\([^)]{1,32}\))\s*$/);
  if (paren) {
    const base = paren[1].replace(/\s+/g, " ").trim();
    return base.length >= 2 && base === base.toUpperCase();
  }
  if (s.length > 44) return false;
  const letters = s.replace(/[^A-Za-z]/g, "");
  return letters.length >= 2 && s === s.toUpperCase();
}

/**
 * Pass 1: skip [a-z][A-Z] inserts inside dialogue/parenthetical blocks (after a character cue
 * until a blank line or new scene heading) so we do not damage mixed-case dialogue.
 */
function applyClauseBoundaryPass(text, whitelistPrefixes) {
  const lines = String(text || "").split(/\r?\n/);
  let clauseCount = 0;
  let inCharacterSpeechBlock = false;
  const outLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      inCharacterSpeechBlock = false;
      return line;
    }
    if (isSceneHeadingLine(trimmed)) {
      inCharacterSpeechBlock = false;
    }
    const isCue = isScreenplayCharacterCue(trimmed);
    const wc = trimmed.split(/\s+/).filter(Boolean).length;
    const looksLikeActionParagraph =
      !isCue &&
      !isSceneHeadingLine(trimmed) &&
      !/^\([^)]+\)\s*$/.test(trimmed) &&
      (wc >= 22 || trimmed.length >= 110);
    if (looksLikeActionParagraph) inCharacterSpeechBlock = false;
    if (isCue) {
      inCharacterSpeechBlock = true;
    }
    const skipClause =
      inCharacterSpeechBlock &&
      !isCue &&
      !isSceneHeadingLine(trimmed);

    if (skipClause || /^\([^)]+\)\s*$/.test(trimmed)) {
      return line;
    }

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
  });
  return { text: outLines.join("\n"), clauseCount };
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

function collectLongLowercaseTokens(text) {
  const t = String(text || "");
  const found = new Set();
  const re = /\b[a-z]{18,}\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const tok = m[0];
    if (!LONG_KNOWN_LOWERCASE_WORDS.has(tok.toLowerCase())) found.add(tok);
  }
  return [...found];
}

function chainedPhraseReplacement(match, a, b) {
  const whole = (a + b).toLowerCase();
  if (CHAINED_SPLIT_DENYLIST.has(whole)) return match;
  // …gether + her (together, altogether, …)
  if (b.toLowerCase() === "her" && /gether$/i.test(a)) return match;
  return `${a} ${b}`;
}

export function fixMergedWordIssuesPhase2Detailed(text, options = {}) {
  const whitelistPrefixes = options.whitelistPrefixes || DEFAULT_WHITELIST_PREFIXES;
  const logs = [];
  let t = String(text || "");

  const clausePass = applyClauseBoundaryPass(t, whitelistPrefixes);
  t = clausePass.text;
  logs.push({ rule: "clause_boundary", count: clausePass.clauseCount });

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

  // 2c) audit: very long lowercase tokens (phrase collapses); no mutation — quality / mining signal
  const longTokens = collectLongLowercaseTokens(t);
  logs.push({
    rule: "long_lowercase_tokens",
    count: longTokens.length,
    tokens: longTokens.slice(0, 40),
  });

  // 3) canonical-name action glue — no leading \\b (short first names like Rui); end still word-ish
  let nameGlueCount = 0;
  const names = expandCanonicalNames(options.characterNames || []);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped.length < 2) continue;
    const re = new RegExp(`(${escaped})([a-z]{2,})(?![a-z])`, "gi");
    const res = applyRegexWithCount(t, re, (_m, a, b) => `${a} ${b}`);
    t = res.text;
    nameGlueCount += res.count;
  }
  logs.push({ rule: "canonical_name_action_glue", count: nameGlueCount });

  // 4) chained phrase split fallback
  const chained = applyRegexWithCount(t, CHAINED_PHRASE_RE, (...args) => {
    const [match, a, b] = args;
    return chainedPhraseReplacement(match, a, b);
  });
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

  // idempotence checksum helper (cheap): rerun once structural + chained transforms
  let rerun = String(t);
  rerun = rerun.replace(CHAINED_PHRASE_RE, (m, a, b) => chainedPhraseReplacement(m, a, b));
  rerun = rerun
    .replace(/([^\n])\s*((?:END\s+(?:OF\s+)?EPISODE\s+\d+|FADE\s+IN|FADE\s+OUT|CUT\s+TO|SMASH\s+CUT)\b)/gi, "$1\n$2")
    .replace(/((?:END\s+(?:OF\s+)?EPISODE\s+\d+|FADE\s+IN|FADE\s+OUT|CUT\s+TO|SMASH\s+CUT)\b)\s*([^\n])/gi, "$1\n$2");
  const idempotent = rerun === t;
  logs.push({ rule: "idempotence_check", count: idempotent ? 0 : 1 });

  return { text: t, logs, idempotent };
}

export function fixMergedWordIssuesPhase2(text, options = {}) {
  return fixMergedWordIssuesPhase2Detailed(text, options).text;
}
