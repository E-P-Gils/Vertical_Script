import fs from "fs";
import path from "path";

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeNameKey(name) {
  if (!name) return "";
  // Normalize curly apostrophes and quotes.
  const s = String(name)
    .replace(/[’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
  // Keep letters/digits/spaces and apostrophes/hyphens. Drop everything else.
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 '\-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseFromHeader(header) {
  if (!header) return "";
  // Convert "JOSEPHINE" -> "Josephine", "ALPHA FLETCHER" -> "Alpha Fletcher"
  // Keep hyphenated forms: "SELF-CONSCIOUSLY" isn't common, but handle anyway.
  return header
    .toLowerCase()
    .split(/\s+/)
    .map((w) => {
      if (!w) return w;
      return w
        .split("-")
        .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
        .join("-");
    })
    .join(" ");
}

function levenshtein(a, b) {
  const s = String(a);
  const t = String(b);
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[n][m];
}

function similarityScore(a, b) {
  const na = normalizeNameKey(a);
  const nb = normalizeNameKey(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 0 : 1 - dist / maxLen;
}

function bestSurfaceForKey(variantStats, key) {
  const entry = variantStats?.[key];
  if (!entry) return key;
  const surfaces = entry.surfaces || {};
  let best = null;
  let bestCount = -1;
  for (const [surface, count] of Object.entries(surfaces)) {
    if (count > bestCount) {
      best = surface;
      bestCount = count;
    }
  }
  return best || key;
}

function looksLikeDialogueCueBaseName(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  // Exclude common shout / stage-direction tokens that are often emitted
  // as standalone ALL-CAPS lines but are not character names.
  if (
    /^(HERE|THERE|THEN|WHEN|WHERE|WHAT|WHY|WHO|YES|NO|OK|OKAY|STOP|RUN|WAIT|HMM|OH|AH|UH|UM|CRASH|SUDDENLY)$/i.test(
      t
    )
  )
    return false;
  // Exclude typical non-character tokens.
  if (/^(INT\.|EXT\.|EPISODE|END)$/i.test(t)) return false;
  // Must be all-caps-ish: only A-Z, digits, spaces, apostrophe, hyphen.
  if (!/^[A-Z0-9][A-Z0-9 '\-]*$/.test(t)) return false;
  // Avoid shouting punctuation lines.
  if (/[.!?]/.test(t)) return false;
  return true;
}

function extractCueBaseNameFromLine(line) {
  let s = String(line || "").trim();
  if (!s) return null;
  // Normalize curly apostrophes for stable regexes.
  s = s.replace(/[’]/g, "'");

  // Strip any trailing "S POV" marker, common in your scripts.
  // e.g. "EMILY LAWRENCE'S POV"
  s = s.replace(/'S\s+POV$/i, "");
  s = s.replace(/\s+POV$/i, (m) => m); // keep until next step
  if (/POV$/i.test(s)) {
    // Remove the POV suffix entirely.
    s = s.replace(/\s+POV$/i, "");
    s = s.trim();
  }

  // Strip cue metadata like "(V.O.)", "(CONT'D)", "(WEAKLY)" etc.
  const parenIdx = s.indexOf("(");
  if (parenIdx >= 0) s = s.slice(0, parenIdx).trim();

  // Strip trailing punctuation.
  s = s.replace(/[,:;]+$/g, "").trim();

  // Some outputs keep possessives before the cue; normalize them away for matching.
  // e.g. "RANDALL'S" -> "RANDALL"
  s = s.replace(/'S$/i, "").trim();

  if (!looksLikeDialogueCueBaseName(s)) return null;
  if (s.length < 3) return null;
  return s;
}

function extractNameVariantsFromEpisodeText(episodeText) {
  const variants = [];
  const lines = String(episodeText || "").split(/\r?\n/);
  for (const line of lines) {
    const base = extractCueBaseNameFromLine(line);
    if (!base) continue;
    variants.push(base);
  }
  return variants;
}

let _cachedRegistryPath = null;
let _cachedRegistry = null;

export function clearCharacterNameRegistryCache() {
  _cachedRegistryPath = null;
  _cachedRegistry = null;
}

export function loadCharacterNameRegistry(registryPath) {
  if (!registryPath) return null;
  const abs = path.resolve(registryPath);
  if (_cachedRegistryPath === abs && _cachedRegistry) return _cachedRegistry;
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, "utf-8");
  const parsed = JSON.parse(raw);
  _cachedRegistryPath = abs;
  _cachedRegistry = parsed;
  return parsed;
}

function initRegistry(seedCanonicalHeaderNames) {
  const canonicalByKey = {};
  const lockedCanonicalKeys = [];
  for (const header of seedCanonicalHeaderNames) {
    const key = normalizeNameKey(header);
    if (!key) continue;
    lockedCanonicalKeys.push(key);
    canonicalByKey[key] = {
      header,
      prose: titleCaseFromHeader(header),
    };
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    lockedCanonicalKeys,
    canonicalByKey,
    // normalizedVariantKey -> { total, surfaces: {surface: count} }
    variantStats: {},
    // normalizedVariantKey -> normalizedCanonicalKey
    variantToCanonicalKey: {},
  };
}

function recomputeVariantToCanonicalKey(registry) {
  const seedCanonicalKeys = new Set(registry.lockedCanonicalKeys || []);

  // Ensure canonicalByKey exists for seeds.
  registry.canonicalByKey = registry.canonicalByKey || {};
  registry.variantStats = registry.variantStats || {};
  registry.variantToCanonicalKey = {};

  const variantKeys = Object.keys(registry.variantStats);
  const seeds = Object.keys(registry.canonicalByKey);

  // 1) Map variants to locked seeds when they're very close.
  for (const vKey of variantKeys) {
    // Skip already-mapped keys; we rebuild anyway.
    let bestSeed = null;
    let bestScore = 0;
    for (const seedKey of seeds) {
      const score = similarityScore(vKey, seedKey);
      if (score > bestScore) {
        bestScore = score;
        bestSeed = seedKey;
      }
    }
    // Conservative: only auto-map to locked trio when extremely similar.
    if (bestSeed && bestScore >= 0.92) {
      registry.variantToCanonicalKey[vKey] = bestSeed;
    }
  }

  // 2) Cluster everything else by similarity.
  // Cluster canonical is the most frequent surface within that cluster.
  const already = new Set(Object.keys(registry.variantToCanonicalKey));
  const remaining = variantKeys
    .filter((k) => !already.has(k))
    .sort((a, b) => {
      const ca = registry.variantStats[a]?.total || 0;
      const cb = registry.variantStats[b]?.total || 0;
      return cb - ca;
    });

  const clusters = []; // { canonicalKey, members:Set<string> }
  const CLUSTER_SIM_THRESHOLD = 0.86;

  for (const vKey of remaining) {
    const existing = clusters.find((cl) => similarityScore(vKey, cl.canonicalKey) >= CLUSTER_SIM_THRESHOLD);
    if (existing) {
      existing.members.add(vKey);
      continue;
    }
    clusters.push({ canonicalKey: vKey, members: new Set([vKey]) });
  }

  for (const cl of clusters) {
    // Pick canonical as the most frequent variantKey in this cluster.
    let bestKey = cl.canonicalKey;
    let bestCount = registry.variantStats[bestKey]?.total || 0;
    for (const k of cl.members) {
      const c = registry.variantStats[k]?.total || 0;
      if (c > bestCount) {
        bestCount = c;
        bestKey = k;
      }
    }

    // Ensure canonicalByKey entry exists for bestKey.
    if (!registry.canonicalByKey[bestKey]) {
      const bestSurface = bestSurfaceForKey(registry.variantStats, bestKey);
      registry.canonicalByKey[bestKey] = {
        header: bestSurface,
        prose: titleCaseFromHeader(bestSurface),
      };
    }

    for (const k of cl.members) {
      registry.variantToCanonicalKey[k] = bestKey;
    }
  }

  // For any seed variants that didn't match: keep them canonical.
  for (const seedKey of seedCanonicalKeys) {
    if (!registry.variantToCanonicalKey[seedKey]) {
      registry.variantToCanonicalKey[seedKey] = seedKey;
    }
  }

  registry.updatedAt = new Date().toISOString();
}

export async function updateCharacterNameRegistryFromEpisode({
  episodeText,
  registryPath,
  seedCanonicalHeaderNames = [],
}) {
  if (!episodeText) return null;

  const seedHeaders = seedCanonicalHeaderNames
    .filter(Boolean)
    .map((n) => String(n).trim())
    .filter(Boolean)
    .map((n) => n.toUpperCase());

  let registry = null;
  try {
    if (fs.existsSync(registryPath)) {
      const raw = fs.readFileSync(registryPath, "utf-8");
      registry = JSON.parse(raw);
    }
  } catch (_) {
    registry = null;
  }

  if (!registry) {
    registry = initRegistry(seedHeaders);
  } else {
    // Ensure seeds exist.
    const seeds = initRegistry(seedHeaders);
    registry.lockedCanonicalKeys = Array.from(
      new Set([...(registry.lockedCanonicalKeys || []), ...(seeds.lockedCanonicalKeys || [])])
    );
    registry.canonicalByKey = registry.canonicalByKey || {};
    for (const [k, v] of Object.entries(seeds.canonicalByKey || {})) {
      if (!registry.canonicalByKey[k]) registry.canonicalByKey[k] = v;
    }
    registry.variantStats = registry.variantStats || {};
  }

  const variants = extractNameVariantsFromEpisodeText(episodeText);

  // Count variants.
  for (const variant of variants) {
    const vKey = normalizeNameKey(variant);
    if (!vKey) continue;
    if (!registry.variantStats[vKey]) {
      registry.variantStats[vKey] = { total: 0, surfaces: {} };
    }
    registry.variantStats[vKey].total += 1;
    registry.variantStats[vKey].surfaces[variant] =
      (registry.variantStats[vKey].surfaces[variant] || 0) + 1;
  }

  recomputeVariantToCanonicalKey(registry);

  // Persist.
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
  clearCharacterNameRegistryCache();

  return registry;
}

function parseCueHeaderLine(line) {
  const raw = String(line || "");
  const indentMatch = raw.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const trimmed = raw.trim();

  const parenIdx = trimmed.indexOf("(");
  const suffix = parenIdx >= 0 ? trimmed.slice(parenIdx).trimEnd() : "";
  const basePart = parenIdx >= 0 ? trimmed.slice(0, parenIdx).trimEnd() : trimmed;

  // Preserve POV suffix if it exists (e.g. "EMILY LAWRENCE'S POV").
  let povSuffix = "";
  let baseForName = basePart;
  const povMatch = basePart.match(/^(.*?)(\s+POV)$/i);
  if (povMatch) {
    baseForName = povMatch[1].trimEnd();
    povSuffix = povMatch[2]; // includes leading space
  }

  // Track possessive casing for header reconstruction.
  const possMatch = baseForName.match(/('S|'s)$/);
  const possessive = possMatch ? possMatch[1] : "";
  const baseNoPoss = possMatch
    ? baseForName.slice(0, -possessive.length).trimEnd()
    : baseForName;

  return { indent, baseNoPoss, possessive, povSuffix, suffix };
}

function isLikelyCueHeaderLine(line) {
  const base = extractCueBaseNameFromLine(line);
  if (!base) return false;
  const trimmed = String(line || "").trim();
  // Must look like "NAME" optionally followed by "(...)".
  const parenIdx = trimmed.indexOf("(");
  if (parenIdx >= 0) {
    // Anything after parentheses must be empty or another parenthetical.
    const after = trimmed.slice(parenIdx);
    if (!/^\([^)]*\)(\s*\([^)]*\))*$/.test(after)) return false;
  }
  return true;
}

function buildProseReplacementRules(registry) {
  const variantToCanonical = registry?.variantToCanonicalKey || {};
  const variantStats = registry?.variantStats || {};
  const canonicalByKey = registry?.canonicalByKey || {};

  const rules = [];

  for (const [variantKey, canonicalKey] of Object.entries(variantToCanonical)) {
    const stats = variantStats[variantKey];
    const canonical = canonicalByKey[canonicalKey];
    if (!stats || !canonical) continue;

    const proseCanonical = canonical.prose || canonical.header || canonicalKey;
    const surfaces = Object.keys(stats.surfaces || {});
    if (!surfaces.length) continue;

    for (const surface of surfaces) {
      if (!surface || typeof surface !== "string") continue;
      const escaped = escapeRegExp(surface.trim());
      if (!escaped) continue;

      // Match "Surface" as a token in prose, optionally followed by "'s"/"'S".
      // Keep the preceding non-word char (or BOS) and preserve suffix capitalization.
      const re = new RegExp(
        `(^|[^A-Za-z0-9])(${escaped})(('s|'S))?(?=$|[^A-Za-z0-9])`,
        "gi"
      );

      rules.push({
        re,
        canonical: proseCanonical,
      });
    }
  }

  return rules;
}

export function normalizeEpisodeCharacterNames(episodeText, registryPath) {
  const registry = loadCharacterNameRegistry(registryPath);
  if (!registry) return episodeText;

  const proseRules = buildProseReplacementRules(registry);
  if (!proseRules.length) return episodeText;

  const lines = String(episodeText || "").split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (isLikelyCueHeaderLine(line)) {
      const parsed = parseCueHeaderLine(line);
      const vKey = normalizeNameKey(parsed.baseNoPoss);
      const canonicalKey = registry.variantToCanonicalKey[vKey] || null;
      const canonical = canonicalKey ? registry.canonicalByKey[canonicalKey] : null;
      const headerCanonical = canonical?.header || parsed.baseNoPoss;

      // Reconstruct: canonical header + possessive + (suffix)
      const spaceBeforeSuffix = parsed.suffix ? " " : "";
      out.push(
        `${parsed.indent}${headerCanonical}${parsed.possessive}${parsed.povSuffix}${spaceBeforeSuffix}${parsed.suffix}`.trimEnd()
      );
      continue;
    }

    // Prose/action/dialogue lines.
    let replaced = line;
    for (const rule of proseRules) {
      replaced = replaced.replace(rule.re, (_m, prefix, _surface, poss) => {
        return `${prefix}${rule.canonical}${poss || ""}`;
      });
    }
    out.push(replaced);
  }

  return out.join("\n");
}

