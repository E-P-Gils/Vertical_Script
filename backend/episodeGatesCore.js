/**
 * Deterministic episode quality gates (format, collapse, repetition, duplicate detection).
 * Single source of truth for server + golden tests — keep in sync with pipeline behavior.
 */
import { gzipSync } from "node:zlib";

function safeStr(val) {
  if (val == null) return "";
  if (typeof val === "string") return val.trim();
  return String(val).trim();
}

export function structuralOpeningGateThreshold() {
  return Math.min(
    1,
    Math.max(0.35, parseFloat(process.env.STRUCTURAL_OPENING_GATE_THRESHOLD || "0.7") || 0.7)
  );
}

/** Statistical / token-level collapse (complements line-heuristic looksLikeContextCollapse). */
const COLLAPSE_NGRAM_SIZE = Math.max(
  3,
  Math.min(8, parseInt(process.env.COLLAPSE_NGRAM_SIZE || "5", 10) || 5)
);
const COLLAPSE_NGRAM_MIN_REPEATS = Math.max(
  5,
  Math.min(80, parseInt(process.env.COLLAPSE_NGRAM_MIN_REPEATS || "10", 10) || 10)
);
const COLLAPSE_TYPE_TOKEN_MIN = Math.min(
  0.45,
  Math.max(0.03, parseFloat(process.env.COLLAPSE_TYPE_TOKEN_MIN || "0.11") || 0.11)
);
const COLLAPSE_GZIP_EXPANSION_MIN = Math.max(
  3,
  Math.min(25, parseFloat(process.env.COLLAPSE_GZIP_EXPANSION_MIN || "5.2") || 5.2)
);
const COLLAPSE_MIN_CHARS_FOR_METRICS = Math.max(
  500,
  Math.min(50000, parseInt(process.env.COLLAPSE_MIN_CHARS_FOR_METRICS || "1400", 10) || 1400)
);

const COLLAPSE_TECH_LEXICON =
  /\b(geology|chemistry|physics|quantum|blockchain|algorithm|nucleosynthesis|pharmacogenomics|ontology|epistemology|topology|astrophysics|biochemistry)\b/i;

const COLLAPSE_ABSTRACT_LEXICON =
  /\b(forevermore|eternity|destiny|cosmos|existence|metaphysics|consciousness|transcend(?:s|ed|ing)?|infinite|eternal|universal|omnipotent|inevitably|perpetually|ceaselessly|endlessly|boundless|immutable|wholeheartedly|willingly|embraced)\b/i;

export function lineHasCollapseLexicon(line) {
  return COLLAPSE_TECH_LEXICON.test(line) || COLLAPSE_ABSTRACT_LEXICON.test(line);
}

export function passesBasicFormatCheck(text) {
  if (!text || typeof text !== "string") return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 25) return false;
  const hasSceneHeading = lines.some((l) => /^(INT|EXT|INT\/EXT|EXT\/INT)[.\s]/i.test(l));
  if (!hasSceneHeading) return false;
  const cueCandidates = lines.filter(
    (l) =>
      /^[A-Z][A-Z0-9 '.\-()]{1,50}$/.test(l) &&
      l.length <= 55 &&
      !/^(INT|EXT|INT\/EXT|EXT\/INT|EPISODE|END\s+EPISODE|FADE|CUT\s+TO|SMASH\s+TO)/i.test(l)
  );
  return cueCandidates.length >= 2;
}

function looksLikeSynonymVomit(text) {
  if (!text || typeof text !== "string") return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;

  let run = 0;
  let maxRun = 0;
  for (const line of lines) {
    const hasPunct = /[.!?;,:]/.test(line);
    const isSingleWord = /^[A-Za-z][A-Za-z'-]{2,}$/.test(line);
    if (!hasPunct && isSingleWord) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  if (maxRun >= 5) return true;

  for (const line of lines) {
    if (/[.!?;,:]/.test(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length >= 12 && words.every((w) => /^[A-Za-z][A-Za-z'-]{1,}$/.test(w))) {
      return true;
    }
  }

  return false;
}

export function hasSentenceLevelMerges(text) {
  if (!text || typeof text !== "string") return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.some((w) => w.length > 25 && /^[A-Za-z]+$/.test(w));
}

function tokenizeForCollapseMetrics(text) {
  return safeStr(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function looksLikeNgramDegenerationRun(text) {
  const raw = safeStr(text);
  if (raw.length < COLLAPSE_MIN_CHARS_FOR_METRICS) return false;
  const tokens = tokenizeForCollapseMetrics(raw);
  const n = COLLAPSE_NGRAM_SIZE;
  if (tokens.length < n * 22) return false;
  const counts = new Map();
  let maxR = 0;
  for (let i = 0; i <= tokens.length - n; i++) {
    const key = tokens.slice(i, i + n).join(" ");
    const c = (counts.get(key) || 0) + 1;
    counts.set(key, c);
    if (c > maxR) maxR = c;
    if (maxR >= COLLAPSE_NGRAM_MIN_REPEATS + 25) break;
  }
  return maxR >= COLLAPSE_NGRAM_MIN_REPEATS;
}

function looksLikeLowTypeTokenRatio(text) {
  const raw = safeStr(text);
  if (raw.length < COLLAPSE_MIN_CHARS_FOR_METRICS) return false;
  const tokens = tokenizeForCollapseMetrics(raw);
  if (tokens.length < 130) return false;
  const ratio = new Set(tokens).size / tokens.length;
  return ratio < COLLAPSE_TYPE_TOKEN_MIN;
}

function looksLikeGzipRepetitionCollapse(text) {
  const raw = safeStr(text);
  if (raw.length < COLLAPSE_MIN_CHARS_FOR_METRICS) return false;
  try {
    const buf = Buffer.from(raw, "utf8");
    const z = gzipSync(buf, { level: 5 });
    const expansion = buf.length / Math.max(1, z.length);
    return expansion >= COLLAPSE_GZIP_EXPANSION_MIN;
  } catch {
    return false;
  }
}

function looksLikeCommaSpamLine(text) {
  const lines = safeStr(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.some((line) => {
    if (line.length < 200) return false;
    const commas = (line.match(/,/g) || []).length;
    const openParen = (line.match(/\(/g) || []).length;
    return commas >= 32 || (commas >= 20 && openParen >= 10);
  });
}

export function buildNameAnchors(names) {
  const anchors = [];
  const pushParts = (full) => {
    const s = safeStr(full).trim();
    if (!s) return;
    anchors.push(s);
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts[0]) anchors.push(parts[0]);
    if (parts.length > 1 && parts[parts.length - 1]) anchors.push(parts[parts.length - 1]);
  };
  pushParts(names?.heroine);
  pushParts(names?.coldCeo);
  pushParts(names?.warmFriend);
  return Array.from(new Set(anchors.map((x) => x.toLowerCase())));
}

function looksLikeContextCollapse(text, names) {
  const raw = safeStr(text);
  if (!raw) return false;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;

  const nameAnchors = buildNameAnchors(names);
  let run = 0;
  let maxRun = 0;
  for (const line of lines) {
    const isScene = /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(line);
    const isCue =
      /^[A-Z][A-Z0-9 '\-]{1,30}$/.test(line) && !/^(EPISODE|END EPISODE|FADE|CUT)/i.test(line);
    const hasName = nameAnchors.some(
      (n) => n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line)
    );
    const words = line.split(/\s+/).filter(Boolean);
    const longListLike =
      words.length >= 10 && (line.includes(",") || line.includes(";")) && !/[.!?]$/.test(line);
    const anchor = isScene || isCue || hasName || words.length <= 5;
    const lexiconHeavy = lineHasCollapseLexicon(line) && words.length >= 8;
    if (!anchor && (longListLike || words.length >= 12 || lexiconHeavy)) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  if (maxRun >= 3) return true;

  return lines.some((line) => {
    const words = line.split(/\s+/).filter(Boolean);
    return (
      (words.length >= 28 || (lineHasCollapseLexicon(line) && words.length >= 12)) &&
      !/^(INT\.|EXT\.)/i.test(line) &&
      !/[.!?]/.test(line)
    );
  });
}

export function hasQualityCollapse(text, names = null) {
  return (
    looksLikeSynonymVomit(text) ||
    looksLikeContextCollapse(text, names) ||
    hasSentenceLevelMerges(text) ||
    looksLikeNgramDegenerationRun(text) ||
    looksLikeLowTypeTokenRatio(text) ||
    looksLikeGzipRepetitionCollapse(text) ||
    looksLikeCommaSpamLine(text)
  );
}

export function extractOpeningFingerprint(text) {
  const lines = safeStr(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let location = "UNKNOWN";
  for (const line of lines) {
    if (/^(INT|EXT|INT\/EXT|EXT\/INT)[.\s]/i.test(line)) {
      location = line
        .replace(/^(INT|EXT|INT\/EXT|EXT\/INT)[.\s-]*/i, "")
        .replace(
          /[-–—]\s*(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|CONTINUOUS|MOMENTS?\s+LATER|LATER)[^)]*$/i,
          ""
        )
        .replace(/\s+\d+\s*$/, "")
        .trim()
        .toUpperCase()
        .slice(0, 60);
      break;
    }
  }

  const actionLines = [];
  let pastHeading = false;
  for (const line of lines) {
    if (actionLines.length >= 5) break;
    if (/^EPISODE\s+\d+/i.test(line) || /^END\s+(OF\s+)?EPISODE/i.test(line)) continue;
    if (/^(INT|EXT|INT\/EXT|EXT\/INT)[.\s]/i.test(line)) {
      pastHeading = true;
      continue;
    }
    if (!pastHeading) continue;
    if (/^[A-Z][A-Z0-9\s'.\-()]{0,50}$/.test(line) && line.length <= 55) continue;
    if (/^\([^)]+\)$/.test(line)) continue;
    actionLines.push(line.toLowerCase());
  }
  const actionText = actionLines.join(" ");

  let action = "other";
  if (
    /\b(pores?\s+over|reads?|studies|studying|traces?\s+the|scrolls?\s+through|flips?\s+through|searches?\s+through|scans?\s+a\s+(page|document|letter|file)|poring\s+over)\b/.test(
      actionText
    )
  )
    action = "researching/reading";
  else if (
    /\b(stands?\s+(at|by|near|over|before|in\s+front)|stands?\s+alone|standing\s+(at|by|over)|gazes?\s+at|stares?\s+at|looks?\s+(out|at|over))\b/.test(
      actionText
    )
  )
    action = "standing/observing";
  else if (
    /\b(walks?\s+(briskly|along|toward|away|through)|strides?|paces?|moves?\s+(through|toward|along)|marches?|approaches?\s+(quietly|slowly|quickly))\b/.test(
      actionText
    )
  )
    action = "walking/moving";
  else if (
    /\b(confronts?|blocks?\s+(her|his|their)\s+path|steps?\s+(in\s+front|between|forward\s+sharply)|faces?\s+each\s+other|squares?\s+off)\b/.test(
      actionText
    )
  )
    action = "confronting";
  else if (
    /\b(fights?|attacks?|lunges?|rushes?|sprints?|runs?|escapes?|dodges?|strikes?|draws?\s+(a\s+)?(weapon|dagger|blade|sword|gun))\b/.test(
      actionText
    )
  )
    action = "fighting/action";
  else if (
    /\b(sits?\s+(at|by|behind|down)|works?\s+at|types?|leans?\s+over|crouches?|kneels?)\b/.test(
      actionText
    )
  )
    action = "sitting/working";
  else if (
    /\b(arrives?|enters?|steps?\s+in(side|to)?|emerges?|appears?\s+(at|from|in\s+the)|walks?\s+in|bursts?\s+(in|through))\b/.test(
      actionText
    )
  )
    action = "arriving/entering";
  else if (
    /\b(waits?|lingers?|pauses?|hesitates?|remains?\s+(still|silent)|stands?\s+in\s+silence)\b/.test(
      actionText
    )
  )
    action = "waiting";

  let dialogueType = "none";
  let lastWasCue = false;
  for (const line of lines) {
    const isCue =
      /^[A-Z][A-Z0-9\s'.\-()]{0,50}$/.test(line) &&
      line.length <= 55 &&
      !/^(INT|EXT|INT\/EXT|EXT\/INT|EPISODE|END\s+EPISODE|FADE|CUT\s+TO|SMASH\s+TO)/i.test(line);
    if (isCue) {
      lastWasCue = true;
      continue;
    }
    if (/^\([^)]+\)$/.test(line)) continue;
    if (!lastWasCue) continue;

    const d = line.toLowerCase();
    if (
      /\b(still\s+chasing|you('re|\s+are)\s+(wasting|wrong|deluded|chasing)|that('s|\s+is)\s+(impossible|ridiculous|insane)|you\s+really\s+think|not\s+this\s+again|give\s+it\s+up|stop\s+chasing)\b/.test(
        d
      )
    )
      dialogueType = "skeptic_dismissal";
    else if (
      /\b(be\s+careful|you('re|\s+are)\s+in\s+danger|stay\s+away|watch\s+your|they('re|\s+are)\s+(coming|watching)|it('s|\s+is)\s+not\s+safe|run\b|get\s+out)\b/.test(
        d
      )
    )
      dialogueType = "warning";
    else if (
      /\b(missed\s+you|good\s+to\s+see|you('re|\s+are)\s+(back|here|finally)|i\s+was\s+looking\s+for\s+you|welcome\s+back|you\s+made\s+it)\b/.test(
        d
      )
    )
      dialogueType = "reunion";
    else if (
      /\b(who\s+are\s+you|state\s+your|what\s+are\s+you\s+doing\s+here|why\s+are\s+you|what\s+do\s+you\s+want|you\s+shouldn't\s+be\s+here|unauthorized)\b/.test(
        d
      )
    )
      dialogueType = "challenge/confrontation";
    else if (
      /\b(we\s+need\s+to|i\s+found\s+(something|it|a)|there('s|\s+is)\s+(a|something|someone)|the\s+(signal|readings?|data|creature|plan|mission))\b/.test(
        d
      )
    )
      dialogueType = "exposition";
    else if (
      /\b(i\s+(love|need|can't\s+stop\s+thinking\s+about|can't\s+lose)|you\s+mean\s+everything|i\s+was\s+wrong\s+about\s+you)\b/.test(
        d
      )
    )
      dialogueType = "intimacy/emotional";
    else if (d.trim().endsWith("?")) dialogueType = "question";
    else dialogueType = "statement";
    break;
  }

  return { location, action, dialogue_type: dialogueType };
}

export function scoreOpeningSimilarity(fp1, fp2) {
  if (!fp1 || !fp2) return 0;

  const normLoc = (loc) =>
    safeStr(loc)
      .toUpperCase()
      .replace(/\b(THE|A|AN|LOWER|UPPER|MAIN|INNER|OUTER|NORTH|SOUTH|EAST|WEST|OLD|NEW)\b/g, "")
      .replace(/\b\d+\b/g, "")
      .replace(/[-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const loc1 = normLoc(fp1.location);
  const loc2 = normLoc(fp2.location);

  let locScore = 0;
  if (loc1 === loc2 && loc1 !== "UNKNOWN") {
    locScore = 1;
  } else {
    const words1 = new Set(loc1.split(/\s+/).filter((w) => w.length > 3));
    const words2 = new Set(loc2.split(/\s+/).filter((w) => w.length > 3));
    const shared = [...words1].filter((w) => words2.has(w)).length;
    const minSize = Math.min(words1.size, words2.size);
    if (minSize > 0) locScore = shared / minSize;
  }

  const actionScore = fp1.action === fp2.action && fp1.action !== "other" ? 1 : 0;
  const dialogueScore =
    fp1.dialogue_type === fp2.dialogue_type &&
    fp1.dialogue_type !== "none" &&
    fp1.dialogue_type !== "statement"
      ? 1
      : 0;

  return locScore * 0.5 + actionScore * 0.3 + dialogueScore * 0.2;
}

export function findMostSimilarPriorOpening(newFingerprint, recaps) {
  if (!newFingerprint || !Array.isArray(recaps) || !recaps.length) return null;

  let best = null;
  for (const r of recaps) {
    if (!r.openingFingerprint) continue;
    const score = scoreOpeningSimilarity(newFingerprint, r.openingFingerprint);
    if (best === null || score > best.score) {
      best = { score, episode: r.episode, fingerprint: r.openingFingerprint };
    }
  }
  return best;
}

export function tagEpisodeEvents(text) {
  const s = safeStr(text).toLowerCase();
  if (!s) return [];
  const tags = new Set();
  const add = (t) => tags.add(t);

  if (/explosion|explode|blast|detonation|bomb\b/.test(s)) add("explosion");
  if (/fire\b|flames?|burning/.test(s)) add("fire");
  if (/elevator|lift shaft|freight elevator/.test(s)) add("elevator_scene");
  if (/warehouse|abandoned factory|storage unit/.test(s)) add("warehouse_scene");
  if (/kidnap|abduct|hostage|tied up|gagged/.test(s)) add("kidnapping");
  if (/car chase|pursuit on the road|screech(es|ed) to a halt/.test(s)) add("car_chase");
  if (/\bmonster\b|creature|shadow beast|werewolf/.test(s)) add("monster_attack");
  if (/\bkiss(es|ed)?\b|their lips meet|press(es|ed) his lips/.test(s)) add("strong_kiss");
  if (/gunshot|shots? fired|pulls? the trigger/.test(s)) add("gunfight");
  if (/storm\b|thunder|lightning/.test(s)) add("storm_atmosphere");

  const opening = s.slice(0, 600);
  if (
    /\b(dock|beach|water.{0,20}edge|ocean.{0,15}scan|sonar device|notebook.{0,20}ocean|ocean.{0,20}notebook|water.{0,15}scan)\b/.test(
      opening
    )
  )
    add("dock_beach_scan_open");

  if (
    /\b(library|archive|royal\s+library|reading\s+room|scriptorium|record\s+room)\b/.test(opening) &&
    /\b(shelf|shelves|bookshelf|bookshelves|tome|tomes|scroll|scrolls|ancient\s+book|dusty|parchment|spine)\b/.test(
      opening
    )
  )
    add("library_research_open");

  if (
    /still\s+chasing\s+(ghosts?|shadows?|monsters?|those\s+waves|sea\s+monsters?|trouble|fairy\s+tales?|your\s+(monster|creature)|dust|old\s+secrets?|the\s+past)/.test(
      s
    )
  )
    add("skeptic_dismissal");

  if (
    /it.s real|that.s real|confirmed.{0,30}(creature|monster|threat)|creature.{0,30}confirmed|everyone.{0,30}(saw|witnessed)|all three.{0,30}(saw|watched|confirmed)/.test(
      s
    )
  )
    add("threat_confirmed");

  return Array.from(tags);
}

export function detectDuplicateEpisodes(scripts, recaps) {
  const flags = [];
  const n = scripts.length;
  if (n < 2) return flags;

  const thresh = structuralOpeningGateThreshold();
  const recapByEp = new Map();
  for (const r of recaps || []) {
    if (typeof r.episode === "number") recapByEp.set(r.episode, r);
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const epA = i + 1;
      const epB = j + 1;

      const recA = recapByEp.get(epA);
      const recB = recapByEp.get(epB);
      const structuralScore =
        recA?.openingFingerprint && recB?.openingFingerprint
          ? scoreOpeningSimilarity(recA.openingFingerprint, recB.openingFingerprint)
          : 0;

      const textScore = repetitionScore(scripts[i], scripts[j]);
      const TEXT_FLAG = 0.35;

      if (structuralScore >= thresh || textScore >= TEXT_FLAG) {
        const reasons = [];
        if (structuralScore >= thresh) {
          const fpA = recA?.openingFingerprint;
          const fpB = recB?.openingFingerprint;
          reasons.push(
            `structural match: ${fpA?.location || "?"} | ${fpA?.action || "?"} → ` +
              `${fpB?.location || "?"} | ${fpB?.action || "?"} (score ${structuralScore.toFixed(2)})`
          );
        }
        if (textScore >= TEXT_FLAG) {
          reasons.push(`text overlap ${(textScore * 100).toFixed(0)}% sentence match`);
        }

        flags.push({
          ep_a: epA,
          ep_b: epB,
          structural_score: Math.round(structuralScore * 100) / 100,
          text_score: Math.round(textScore * 100) / 100,
          severity:
            structuralScore >= thresh && textScore >= TEXT_FLAG
              ? "high"
              : structuralScore >= 0.8 || textScore >= 0.5
                ? "medium"
                : "low",
          reasons,
        });
      }
    }
  }

  flags.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    if (sevOrder[a.severity] !== sevOrder[b.severity])
      return sevOrder[a.severity] - sevOrder[b.severity];
    return b.structural_score + b.text_score - (a.structural_score + a.text_score);
  });

  return flags;
}

export function repetitionScore(currentText, previousText) {
  if (!currentText || !previousText) return 0;
  const splitSentences = (txt) =>
    txt
      .split(/[\.\?!\n]+/g)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 20);

  const curSentences = splitSentences(currentText);
  const prevSentences = splitSentences(previousText);
  if (!curSentences.length || !prevSentences.length) return 0;

  const prevSet = new Set(prevSentences);
  let overlap = 0;
  for (const s of curSentences) {
    if (prevSet.has(s)) overlap += 1;
  }
  return overlap / curSentences.length;
}

export function findVerbatimPhrases(currentText, priorTexts, minWords = 8) {
  if (!currentText || !priorTexts || priorTexts.length === 0) return [];
  const normalize = (t) =>
    safeStr(t)
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const words = normalize(currentText).split(" ").filter(Boolean);
  if (words.length < minWords) return [];

  const priorNormalized = priorTexts.map((t) => normalize(safeStr(t)));

  const matched = [];
  const seen = new Set();

  for (let i = 0; i <= words.length - minWords; i++) {
    const phrase = words.slice(i, i + minWords).join(" ");
    if (seen.has(phrase)) continue;
    if (priorNormalized.some((prior) => prior.includes(phrase))) {
      seen.add(phrase);
      const idx = normalize(currentText).indexOf(phrase);
      const original =
        idx >= 0 ? currentText.slice(idx, idx + phrase.length + 20).split(/\n/)[0].trim() : phrase;
      matched.push(original.slice(0, 120));
      if (matched.length >= 5) break;
    }
  }
  return matched;
}

export function maxTailBlockOverlap(prevText, curText) {
  if (!prevText || !curText) return 0;
  const norm = (t) =>
    t
      .replace(/\r\n/g, "\n")
      .replace(/[\u00A0\u2000-\u200B\uFEFF]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const p = norm(prevText);
  const c = norm(curText);
  if (p.length < 120 || c.length < 80) return 0;
  const tail = p.slice(-2400);
  let best = 0;
  const minLen = 95;
  const maxLen = Math.min(720, tail.length);
  for (let len = maxLen; len >= minLen; len -= 30) {
    for (let start = Math.max(0, tail.length - 1100); start <= tail.length - len; start += 40) {
      const block = tail.slice(start, start + len);
      if (block.length < minLen) continue;
      if (c.includes(block)) best = Math.max(best, block.length);
    }
  }
  return best;
}

export function measureRepetitionAgainstRecent(episodeText, recentScripts) {
  const REPETITION_THRESHOLD = 0.35;
  const BLOCK_OVERLAP_MIN = 105;
  if (!episodeText || !recentScripts?.length) {
    return {
      needsRetry: false,
      maxScore: 0,
      maxBlockDup: 0,
      verbatimMatches: [],
      REPETITION_THRESHOLD,
      BLOCK_OVERLAP_MIN,
    };
  }
  let maxScore = 0;
  let maxBlockDup = 0;
  for (const prev of recentScripts) {
    const s = repetitionScore(episodeText, prev);
    const b = maxTailBlockOverlap(prev, episodeText);
    if (s > maxScore) maxScore = s;
    if (b > maxBlockDup) maxBlockDup = b;
  }
  const verbatimMatches = findVerbatimPhrases(episodeText, recentScripts);
  const needsRetry =
    maxScore > REPETITION_THRESHOLD ||
    maxBlockDup >= BLOCK_OVERLAP_MIN ||
    verbatimMatches.length > 0;
  return {
    needsRetry,
    maxScore,
    maxBlockDup,
    verbatimMatches,
    REPETITION_THRESHOLD,
    BLOCK_OVERLAP_MIN,
  };
}
