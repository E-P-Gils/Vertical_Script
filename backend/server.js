/**
 * Backend for vertical script generator.
 * Load .env from project root; expects OPENAI_API_KEY and optional OPENAI_FINETUNED_MODEL.
 */
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getSeriesNames } from "./nameEngine.js";
import { generateLogline, SUPPORTED_GENRES } from "./loglineEngine.js";
import {
  updateCharacterNameRegistryFromEpisode,
  normalizeEpisodeCharacterNames,
} from "./characterNameRegistry.js";
import { fixMergedWordIssuesPhase2, fixMergedWordIssuesPhase2Detailed } from "./mergedWordsFix.js";
import { auditMergedWords } from "./mergedWordsAudit.js";
import { initDb } from "./db.js";
import { loginUser, registerUser, requireAuth, verifyEmailCode } from "./auth.js";
import { loadDynamicMergePatterns } from "./mergePatternRegistry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
dotenv.config({ path: join(rootDir, ".env") });

const CHARACTER_NAME_REGISTRY_PATH = join(
  rootDir,
  "character-name-registry.json"
);
const DYNAMIC_MERGE_PATTERNS_PATH = join(
  rootDir,
  "backend",
  "merging_audit",
  "dynamic-merge-patterns-promoted.json"
);

const app = express();
const corsOptions = {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
// Translation endpoint may receive the full English script in one request.
// Increase body limit to avoid HTTP 413 on larger seasons.
app.use(express.json({ limit: "20mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FINETUNED_MODEL =
  process.env.OPENAI_FINETUNED_MODEL ||
  "ft:gpt-4.1-mini-2025-04-14:personal:vertical-genre:DJdSjUra";
const PLANNER_MODEL =
  process.env.OPENAI_PLANNER_MODEL || "gpt-4.1-mini";
const RECAP_MODEL =
  process.env.OPENAI_RECAP_MODEL || PLANNER_MODEL;
/** Model for EN→ZH screenplay translation (defaults to planner; not the fine-tuned writer). */
const TRANSLATION_MODEL =
  process.env.OPENAI_TRANSLATION_MODEL || PLANNER_MODEL;

const NAME_VALIDATION_MODEL =
  process.env.OPENAI_NAME_VALIDATION_MODEL || PLANNER_MODEL;
const GENERATION_MODE = String(process.env.GENERATION_MODE || "single_pass").trim().toLowerCase();
const ENABLE_TWO_PASS_EPISODE = GENERATION_MODE === "two_pass";
const ENABLE_TRIMMED_CONTEXT =
  String(process.env.ENABLE_TRIMMED_CONTEXT || "true").trim().toLowerCase() !== "false";
const CONTEXT_TAIL_LINES = Math.max(
  8,
  Math.min(40, parseInt(process.env.CONTEXT_TAIL_LINES || "14", 10) || 14)
);
const ANCHOR_ENFORCEMENT_MODE = String(process.env.ANCHOR_ENFORCEMENT_MODE || "warn")
  .trim()
  .toLowerCase(); // off | warn | enforce

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  // Do not hard-exit: allow the server to start for auth + other non-OpenAI routes.
  // Endpoints that call OpenAI will fail later with a clear error.
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY || "",
  // Allow slower responses on free Render / high latency routes
  timeout: 600_000, // 10 minutes in milliseconds
  maxRetries: 2,
});
const DYNAMIC_MERGE_PATTERNS = loadDynamicMergePatterns(DYNAMIC_MERGE_PATTERNS_PATH);
if (DYNAMIC_MERGE_PATTERNS.length) {
  console.log(
    `Loaded ${DYNAMIC_MERGE_PATTERNS.length} dynamic merge patterns from ${DYNAMIC_MERGE_PATTERNS_PATH}`
  );
}

// ---------------------------------------------------------------------------
// Genre logline normalization ("custom summary" hardening)
// ---------------------------------------------------------------------------

const GENRE_LOGLINE_NORMALIZER_SYSTEM_PROMPT = `You are a development exec for vertical, romance-forward serialized dramas.

You will receive:
- genre
- three main character names (heroine, male1=cold lead, male2=warm lead)
- a user-provided premise

Goal: rewrite the premise into a tight vertical-series "genre bible" that makes long multi-episode generation stable:
- Keep the SAME three main characters only as protagonists (heroine + two male leads). Never replace them.
- Lock the story to ONE primary setting hub so the series cannot drift into unrelated locations unless the premise explicitly demands it.
- Make stakes and the central obstacle/threat explicit.
- Provide 2–4 simple RULES/CONSTRAINTS that remain true across episodes (these prevent narrative drift).
- Keep romance/power dynamics central for vertical pacing.

Genre guidance:
- Horror: define a clear THREAT, rules of the threat, and escalation stakes; prioritize dread/atmosphere over action-gore.
- Crime: define the crime/secret, the pressure source, and rules about evidence/blackmail/legal risk.
- Fantasy/Sci-Fi/Superhero: define the power system in 1 sentence + rules/limits; avoid inventing new magic/tech every episode.
- Drama/Romance: define the social stakes (family/company/reputation) + rules (e.g. contract marriage, hidden identity).
- Monster/Werewolf: define the creature/pack hierarchy + rules and consequences.

Output ONLY valid JSON:
{
  "logline": "1–2 sentences",
  "setting_hub": "short phrase",
  "stakes": "1 sentence",
  "central_obstacle": "1 sentence",
  "threat": "optional; 1 sentence (use for Horror/Monster/Werewolf if relevant)",
  "rules": ["rule 1", "rule 2", "rule 3"]
}`;

async function normalizeGenreLogline({ rawLogline, genre, names }) {
  const clean = safeStr(rawLogline).slice(0, 1500);
  if (!clean) return null;
  const payload = {
    genre: safeStr(genre) || "Romance",
    heroine: names?.heroine || null,
    male1: names?.coldCeo || null,
    male2: names?.warmFriend || null,
    premise: clean,
  };
  const completion = await openai.chat.completions.create({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: GENRE_LOGLINE_NORMALIZER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    max_tokens: 450,
    temperature: 0.25,
  });
  const rawContent = completion.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  const objMatch = content.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    const parsed = JSON.parse(objMatch[0]);
    if (!parsed || typeof parsed.logline !== "string" || !parsed.logline.trim()) return null;
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.map((r) => safeStr(r)).filter(Boolean).slice(0, 4)
      : [];
    return {
      logline: parsed.logline.trim().slice(0, 1500),
      setting_hub:
        typeof parsed.setting_hub === "string"
          ? parsed.setting_hub.trim().slice(0, 140)
          : "",
      stakes: typeof parsed.stakes === "string" ? parsed.stakes.trim().slice(0, 350) : "",
      central_obstacle:
        typeof parsed.central_obstacle === "string"
          ? parsed.central_obstacle.trim().slice(0, 350)
          : "",
      threat: typeof parsed.threat === "string" ? parsed.threat.trim().slice(0, 350) : "",
      rules,
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Name engine: mix-and-match first/last + family names (see nameEngine.js)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 1: Season blueprint schema and prompts (used in Phase 2 for one-shot outline)
// ---------------------------------------------------------------------------
//
// SeasonBlueprint = {
//   series_title: string,
//   heroine: string,
//   male1: string,
//   male2: string,
//   genre: "WEREWOLF" | "NON_WEREWOLF",
//   episodes: EpisodePlan[]
// }
//
// EpisodePlan = {
//   episode: number,
//   arc_phase: "hook" | "escalation" | "turning_point" | "endgame" | "finale",
//   title: string,
//   setting_focus: string,
//   emotional_focus: string,
//   heroine_state: string,
//   male1_state: string,
//   male2_state: string,
//   main_conflict: string,
//   key_events: string[],
//   twist_or_reveal: string,
//   cliffhanger_type: string,
//   cliffhanger: string
// }
//
// Arc ranges for 60 episodes: hook 1-5, escalation 6-20, turning_point 21-40, endgame 41-55, finale 56-60.

const BLUEPRINT_ARC_RANGES = Object.freeze({
  hook: [1, 5],
  escalation: [6, 20],
  turning_point: [21, 40],
  endgame: [41, 55],
  finale: [56, 60],
});

function getArcPhaseForEpisode(ep, total = 60) {
  if (ep <= 0) return "hook";
  const n = Math.min(ep, total);
  if (n <= 5) return "hook";
  if (n <= 20) return "escalation";
  if (n <= 40) return "turning_point";
  if (n <= 55) return "endgame";
  return "finale";
}

const BLUEPRINT_SYSTEM_PROMPT = `You are a season planner for female-led vertical romance dramas.

The user will give you: language, genre (WEREWOLF or NON_WEREWOLF), total episode count (e.g. 60), the three main character names (heroine, cold male lead, warm male lead), and a short series logline.
They may also give you high-level trope controls.

You must output a single JSON object (no other text, no markdown) with this exact structure:

{
  "series_title": "A short title for the series",
  "heroine": "Full name as given",
  "male1": "Full name as given",
  "male2": "Full name as given",
  "genre": "WEREWOLF or NON_WEREWOLF",
  "tropes": {
    "romantic": ["..."],
    "conflict": ["..."],
    "supernatural": ["..."]
  },
  "characters": [
    {
      "name": "Heroine's full name",
      "role": "heroine_protagonist",
      "goal": "Her long-term season goal in one sentence (e.g., expose a conspiracy, save her family, escape a toxic marriage).",
      "traits": ["underdog", "resilient", "smart"],
      "taboos": ["becoming a villain", "suddenly forgetting her core values"]
    },
    {
      "name": "Cold male lead full name",
      "role": "cold_male_lead",
      "goal": "His long-term goal in one sentence.",
      "traits": ["powerful", "proud", "controlled"],
      "taboos": ["becoming pure comic relief", "changing profession mid-season without a planned turning point"]
    },
    {
      "name": "Warm male lead full name",
      "role": "warm_male_lead",
      "goal": "His long-term goal in one sentence.",
      "traits": ["protective", "patient", "loyal"],
      "taboos": ["becoming main villain", "randomly disappearing with no payoff"]
    }
  ],
  "episodes": [
    {
      "episode": 1,
      "arc_phase": "hook",
      "title": "Episode title",
      "setting_focus": "school | office | family_mansion | hospital | banquet | werewolf_territory | other",
      "emotional_focus": "humiliation | yearning | betrayal | revenge | redemption | reunion",
      "heroine_state": "One sentence: where she is in life and with the men",
      "male1_state": "One sentence: cold lead's stance",
      "male2_state": "One sentence: warm lead's stance",
      "main_conflict": "One sentence: core conflict this episode",
      "key_events": ["Event 1", "Event 2", "Event 3"],
      "twist_or_reveal": "One sentence: twist or reveal",
      "cliffhanger_type": "emotional | plot_twist | danger | reversal",
      "cliffhanger": "One sentence: how the episode ends to hook the next",
      "hook_type": "meet_cute | humiliation | danger | secret_overheard | other",
      "conflict_type": "family_pressure | money_business | social_status | secret_reveal | rival_scheme | romantic_tension | supernatural_danger | other",
      "micro_beats": [
        "Hook beat: 1 short sentence describing the opening emotional moment (0–5 seconds).",
        "Conflict beat: 1–2 short sentences describing the main conflict for this episode (5–30 seconds).",
        "Mini-twist beat: 1 short sentence describing a twist or shift in power/emotion near the end of the episode.",
        "Cliffhanger beat: 1 short sentence describing how the final lines end on a hook that points directly into the next episode."
      ]
    }
  ]
}


Trope control:
- The optional "tropes" object can contain three arrays of high-level tropes:
  - romantic: e.g. ["secret_billionaire", "contract_marriage", "childhood_sweethearts", "forbidden_love"]
  - conflict: e.g. ["hidden_heir", "corporate_war", "family_feud", "revenge_plot"]
  - supernatural: e.g. ["monster_awakening", "cursed_bloodline", "prophetic_dreams"]
- If tropes are provided, you MUST weave them through the whole season:
  - At least one romantic trope should show up clearly every 3–4 episodes.
  - At least one conflict trope should drive external stakes in each arc_phase.
  - Supernatural tropes (when present) should be introduced early, escalated in the middle, and paid off in the finale.

Season arc rules (macro-structure):
- Produce exactly one object per episode in order (episode 1 through the total given).
- arc_phase must follow the season arc: episodes 1–5 "hook" (setup), 6–20 "escalation", 21–40 "turning_point", 41–55 "endgame", 56–60 "finale".
- Same heroine and two male leads in every episode; their states evolve but names never change.
- Story must have a clear beginning, middle, and end across the full season; no resets.

Character role locking:
- You MUST include the "characters" array with exactly three entries (heroine, cold male lead, warm male lead) on every blueprint. Downstream script generation copies these into every episode prompt; omitting the array breaks cast consistency.
- The "characters" array must describe the heroine and the two main male leads using stable roles, goals, traits, and taboos.
- These roles MUST remain consistent across all episodes: do NOT turn the heroine into a villain, swap the cold/warm male leads' archetypes, or radically change professions/alignments unless the arc_phase and episode plan clearly mark a turning point.
- If a turning point changes a character’s alignment (e.g., warm lead betrays heroine), it must be foreshadowed and then stay consistent afterward; no random flip-flopping.

Per-episode structure rules (micro-structure):
- Every episode must be planned as HOOK → CONFLICT → MINI-TWIST → CLIFFHANGER.
- The "micro_beats" array MUST always have exactly four entries in this exact order:
  1) Hook beat (opening emotional moment).
  2) Conflict beat (core conflict of this episode).
  3) Mini-twist beat (shift/reveal near the end).
  4) Cliffhanger beat (final lines that hook into the next episode).
- The HOOK beat must be short, vivid, and emotional (intimacy, humiliation, jealousy, shock, or danger focused on the heroine).
- The CONFLICT beat must be concrete (what exactly goes wrong, who pushes against the heroine).
- The MINI-TWIST beat should be smaller than the episode’s cliffhanger, but still change power/emotion or information.
- The CLIFFHANGER beat must directly grow out of this episode’s conflict and mini-twist; do NOT introduce a completely new subplot just for the last line.

Variety and pacing:
- For episodes 1–10 especially: plan a strong OPENING hook (e.g. intimacy/tension, heroine bullied or in danger, male lead’s presence/physical appeal) and a strong CLOSING hook (e.g. male lead saves/defends her, rescue, charged moment, reveal). PG-13 only.
- Vary the main conflict_type across the season: every 3–5 episodes, rotate between family pressure, money/business/contracts, social reputation/public humiliation, secrets/reveals, rival schemes, and romantic tension. Do NOT let 4+ episodes in a row revolve around the same physical scenario (e.g. chase → corner → forced kiss).
- Physical closeness beats (kisses, grabs, cornering) should be planned as spikes, not the only conflict: after early hook episodes, focus escalation on external stakes (family approval, deals, inheritances, pack politics, social status) and heroine leverage.

Finale shaping:
- Episodes in arc_phase "finale" (typically 56–60) must clearly move the story toward resolution: fewer new villains, more payoffs of existing secrets and conflicts.

Output only valid JSON. No commentary before or after.`;

function buildBlueprintPrompt({ logline, names, genre, episodeCount, tropes }) {
  const total = Math.max(1, Math.min(120, episodeCount || 60));
  const heroine = (names && names.heroine) || "EMMA LIN";
  const male1 = (names && names.coldCeo) || "ADRIAN LUO";
  const male2 = (names && names.warmFriend) || "LIAM CHEN";
  const familyName = names && names.familyName;
  const corporationName = names && names.corporationName;
  const genreTag = String(genre || "Romance").trim() || "Romance";
  const cleanLogline = safeStr(logline).slice(0, 1500);

  let tropesLine = "";
  if (tropes && typeof tropes === "object") {
    const romantic = Array.isArray(tropes.romantic) ? tropes.romantic : [];
    const conflict = Array.isArray(tropes.conflict) ? tropes.conflict : [];
    const supernatural = Array.isArray(tropes.supernatural) ? tropes.supernatural : [];
    const parts = [];
    if (romantic.length)
      parts.push(`romantic_tropes=[${romantic.slice(0, 6).join(", ")}]`);
    if (conflict.length)
      parts.push(`conflict_tropes=[${conflict.slice(0, 6).join(", ")}]`);
    if (supernatural.length)
      parts.push(`supernatural_tropes=[${supernatural.slice(0, 6).join(", ")}]`);
    if (parts.length) {
      tropesLine = `TROPE CONTROLS: ${parts.join(" | ")}.`;
    }
  }

  const lines = [
    `[LANG=EN] [GENRE=${genreTag}] [EPISODES=${total}]`,
    `[HEROINE=${heroine}] [MALE1=${male1}] [MALE2=${male2}]`,
    familyName
      ? familyName.endsWith(" Pack")
        ? `Optional pack for this series: the ${familyName}.`
        : `Optional dynasty/family name for this series: the ${familyName} family.`
      : "",
    corporationName ? `Optional corporation for finance/boardroom storylines: ${corporationName}.` : "",
    cleanLogline ? `[LOGLINE] ${cleanLogline}` : "",
    tropesLine,
    `Generate a full ${total}-episode season outline in the exact JSON format described. One entry in "episodes" per episode, in order.`,
  ];
  return lines.filter(Boolean).join("\n");
}

function parseBlueprintFromContent(content) {
  const raw = (content || "").trim();
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    return JSON.parse(objMatch[0]);
  } catch (_) {
    return null;
  }
}

/**
 * The episode writer only sees character roles if blueprint.characters is present.
 * Models sometimes omit the array (or truncate JSON); fill from locked name tags so
 * constraints apply for every genre the same way.
 */
function hydrateBlueprintCharactersFromNames(blueprint, names) {
  if (!blueprint || typeof blueprint !== "object" || !names) return blueprint;
  const filled = Array.isArray(blueprint.characters)
    ? blueprint.characters.filter((c) => c && typeof c.name === "string" && c.name.trim())
    : [];
  if (filled.length >= 3) return blueprint;

  const h = safeStr(names.heroine).trim() || "HEROINE";
  const m1 = safeStr(names.coldCeo).trim() || "COLD_MALE_LEAD";
  const m2 = safeStr(names.warmFriend).trim() || "WARM_MALE_LEAD";

  blueprint.characters = [
    {
      name: h,
      role: "heroine_protagonist",
      goal: "Carry the season’s emotional arc; grow from underdog to agency without losing core values.",
      traits: ["underdog", "resilient", "emotionally driven"],
      taboos: [
        "recast or merge with another love-interest",
        "random alignment flip without a planned turning point",
      ],
    },
    {
      name: m1,
      role: "cold_male_lead",
      goal: "Embody power, pride, and guarded desire toward the heroine; evolve without swapping archetypes with the warm lead.",
      traits: ["powerful", "controlled", "protective underneath"],
      taboos: [
        "swap roles with the warm male lead",
        "become comic relief only",
        "change profession or family tie without set-up",
      ],
    },
    {
      name: m2,
      role: "warm_male_lead",
      goal: "Offer steadiness and loyalty; compete for the heroine without becoming the main villain unless foreshadowed.",
      traits: ["protective", "patient", "loyal"],
      taboos: [
        "merge into the cold lead’s personality",
        "vanish for many episodes with no payoff",
      ],
    },
  ];
  return blueprint;
}

/** Same bullets as blueprint context, when generation runs without a season outline. */
function formatFallbackCharacterConstraints(names) {
  if (!names || !names.heroine || !names.coldCeo || !names.warmFriend) return "";
  const lines = [
    "CHARACTER ROLE CONSTRAINTS (locked cast — same for every genre; do NOT break these):",
    `- ${names.heroine} | role: heroine_protagonist | taboos: do not swap her with a different heroine; do not rewrite her as parent/guardian of the male leads unless the logline already says so.`,
    `- ${names.coldCeo} | role: cold_male_lead | taboos: do not merge with ${names.warmFriend}; do not randomly become her father/brother unless the logline already establishes that.`,
    `- ${names.warmFriend} | role: warm_male_lead | taboos: do not merge with ${names.coldCeo}; stay a distinct person and relationship vector.`,
    "",
  ];
  return lines.join("\n");
}

async function generateSeasonBlueprint({ episodeCount, logline, genre, names, tropes }) {
  const userContent = buildBlueprintPrompt({
    logline,
    names,
    genre,
    episodeCount,
    tropes,
  });

  const completion = await openai.chat.completions.create({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: BLUEPRINT_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 4096,
    temperature: 0.6,
    frequency_penalty: 0.7,
    presence_penalty: 0.1,
  });

  const rawContent = completion.choices?.[0]?.message?.content;
  const content =
    typeof rawContent === "string" && rawContent.trim()
      ? rawContent.trim()
      : "";
  const blueprint = parseBlueprintFromContent(content);
  if (!blueprint || !Array.isArray(blueprint.episodes)) {
    throw new Error("Failed to parse season blueprint JSON");
  }
  hydrateBlueprintCharactersFromNames(blueprint, names);
  return blueprint;
}

const EPISODE_SUMMARY_SYSTEM_PROMPT = `You are a story planner for female-led vertical romance dramas.

You will be given:
- A short logline for the whole series.
- A JSON object with "episodes": an array of episode plans for ONE season, each including fields like: episode, arc_phase, title, main_conflict, key_events, twist_or_reveal, cliffhanger, hook_type, conflict_type, and micro_beats.

Your task:
- For EACH episode in order, write a short prose episode summary that the scriptwriter will follow beat-for-beat.
- Each summary must:
  - Be 3–6 sentences maximum.
  - Explicitly follow the HOOK → CONFLICT → MINI-TWIST → CLIFFHANGER pattern implied by micro_beats.
  - Mention the heroine and at least one male lead by name where relevant.
  - Stay consistent with the "arc_phase" (hook, escalation, turning_point, endgame, finale).
- Do NOT invent brand-new villains, conspiracies, supernatural systems, or locations that are not implied by the episode plans; focus on clarifying and stitching together what is already there.

Output format:
- Output a single JSON object (no other text, no markdown) with:
{
  "episode_summaries": [
    { "episode": 1, "summary": "..." },
    { "episode": 2, "summary": "..." }
  ]
}

Each "summary" should be plain text (no newlines inside, no quotes beyond simple dialogue if needed).`;

function parseEpisodeSummariesFromContent(content) {
  const raw = (content || "").trim();
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    const parsed = JSON.parse(objMatch[0]);
    if (!parsed || !Array.isArray(parsed.episode_summaries)) return null;
    const map = new Map();
    for (const item of parsed.episode_summaries) {
      if (
        item &&
        typeof item.episode === "number" &&
        typeof item.summary === "string" &&
        item.summary.trim()
      ) {
        map.set(item.episode, item.summary.trim());
      }
    }
    return map;
  } catch (_) {
    return null;
  }
}

async function generateEpisodeSummaries({ blueprint, logline, genre }) {
  if (!blueprint || !Array.isArray(blueprint.episodes) || !blueprint.episodes.length) {
    return null;
  }
  const payload = {
    logline: safeStr(logline).slice(0, 1500),
    genre: String(genre || "Romance").trim() || "Romance",
    episodes: blueprint.episodes,
  };
  const userContent = JSON.stringify(payload);

  const completion = await openai.chat.completions.create({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: EPISODE_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 4096,
    temperature: 0.5,
  });

  const rawContent = completion.choices?.[0]?.message?.content;
  const content =
    typeof rawContent === "string" && rawContent.trim() ? rawContent.trim() : "";
  const map = parseEpisodeSummariesFromContent(content);
  return map;
}

const RECAP_SYSTEM_PROMPT = `You are an assistant that summarizes vertical drama episodes.

Given the full script text for ONE episode, write a single concise sentence (15–35 words) that describes what happens to the heroine and how the episode ends, focusing on the emotional and plot cliffhanger.

Output ONLY the sentence. No bullet points, no extra commentary.`;

const EPISODE_STATE_SYSTEM_PROMPT = `You summarize ONE episode into strict JSON.
Return ONLY JSON in this exact shape:
{
  "location": "last scene location (short phrase)",
  "ending": "one sentence ending/cliffhanger state",
  "character_state": "one sentence emotional position of heroine + two male leads"
}`;

const NARRATIVE_RESET_SYSTEM_PROMPT = `You create a compact narrative reset for long-running serialized scripts.
Given recap lines and cast names, return ONLY text under 400 tokens with:
1) Current cast emotional positions
2) Central conflict status
3) Unresolved threads (max 6 bullets)
4) Immediate next-step pressure
Do not add new plotlines.`;

async function summarizeEpisode({ episodeNumber, text }) {
  const clean = safeStr(text);
  if (!clean) return null;

  const completion = await openai.chat.completions.create({
    model: RECAP_MODEL,
    messages: [
      { role: "system", content: RECAP_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Episode ${episodeNumber} script:\n\n${clean.slice(
          0,
          8000
        )}`,
      },
    ],
    max_tokens: 96,
    temperature: 0.4,
    frequency_penalty: 0.5,
    presence_penalty: 0.0,
  });

  const rawContent = completion.choices?.[0]?.message?.content;
  const recap =
    typeof rawContent === "string" && rawContent.trim()
      ? rawContent.trim()
      : null;
  return recap;
}

async function summarizeEpisodeState({ episodeNumber, text }) {
  const clean = safeStr(text);
  if (!clean) return null;
  const completion = await openai.chat.completions.create({
    model: RECAP_MODEL,
    messages: [
      { role: "system", content: EPISODE_STATE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Episode ${episodeNumber} script:\n\n${clean.slice(0, 7000)}`,
      },
    ],
    max_tokens: 180,
    temperature: 0.2,
  });
  const raw = safeStr(completion.choices?.[0]?.message?.content);
  const jsonMatch = raw.match(/\{[\s\S]*\}$/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      episode: episodeNumber,
      location: safeStr(parsed.location).slice(0, 120),
      ending: safeStr(parsed.ending).slice(0, 260),
      character_state: safeStr(parsed.character_state).slice(0, 320),
    };
  } catch {
    return null;
  }
}

async function buildFullNarrativeReset(episodeRecaps, names, logline, episodeNumber) {
  const recaps = Array.isArray(episodeRecaps)
    ? episodeRecaps
        .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber)
        .slice(-16)
    : [];
  if (!recaps.length) return "";
  const recapText = recaps.map((r) => `Ep ${r.episode}: ${safeStr(r.recap)}`).join("\n");
  const completion = await openai.chat.completions.create({
    model: RECAP_MODEL,
    messages: [
      { role: "system", content: NARRATIVE_RESET_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `LOGLINE:\n${safeStr(logline).slice(0, 700)}\n\n` +
          `CAST:\nHeroine=${safeStr(names?.heroine)}\nMale1=${safeStr(names?.coldCeo)}\nMale2=${safeStr(names?.warmFriend)}\n\n` +
          `RECAPS:\n${recapText}`,
      },
    ],
    max_tokens: 420,
    temperature: 0.25,
  });
  return safeStr(completion.choices?.[0]?.message?.content).slice(0, 2600);
}

/**
 * Phase 1c — Format all prior episode opening fingerprints into a compact
 * "EPISODE OPENING HISTORY" block injected into every episode prompt.
 * Covers ALL previous episodes (not a sliding window) so patterns that
 * haven't repeated in 10 episodes are still banned.
 */
function formatOpeningHistory(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const prev = recaps
    .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber && r.openingFingerprint)
    .sort((a, b) => a.episode - b.episode);
  if (!prev.length) return "";

  const rows = prev.map((r) => {
    const fp = r.openingFingerprint;
    return `  Ep ${String(r.episode).padStart(2, " ")}: ${fp.location.slice(0, 40).padEnd(40, " ")} | ${fp.action.padEnd(22, " ")} | ${fp.dialogue_type}`;
  });

  return [
    "EPISODE OPENING HISTORY — every prior episode's opening structure (location | first action | dialogue type).",
    "You MUST write an opening that is structurally different from ALL entries below.",
    "Different location, different first action, different dialogue type — the audience must never feel déjà vu:",
    ...rows,
  ].join("\n");
}

function formatRecapContext(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const prev = recaps
    .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber)
    .slice(-6); // expanded from -3
  if (!prev.length) return "";
  const lines = ["RECENT EPISODE RECAPS (actual story so far):"];
  for (const r of prev) {
    lines.push(`  Ep ${r.episode}: ${r.recap}`);
  }
  return lines.join("\n");
}

/**
 * Compact full-series history — all recaps truncated to 90 chars each.
 * Gives the model the complete story arc so it cannot "forget" events from earlier episodes.
 * Only injected when ep > 3 (no history yet to speak of before then).
 */
function formatSeriesHistoryBlock(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const all = recaps
    .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber);
  if (all.length < 3) return ""; // not enough history to be useful
  const lines = [
    "FULL SERIES HISTORY — every episode written so far (characters carry all of this forward; never contradict or reset):",
  ];
  for (const r of all) {
    lines.push(`  Ep ${r.episode}: ${safeStr(r.recap).slice(0, 90)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Simple event tagging: detect big repeated set-pieces to steer away from.
// ---------------------------------------------------------------------------

/**
 * Extracts the opening beat fingerprint of an episode:
 * first scene heading + first 2-3 non-cue, non-metadata lines.
 * Stored per recap so the model can be shown exactly what it used before.
 */
function extractOpeningBeat(text) {
  const lines = safeStr(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const beats = [];
  for (const line of lines) {
    if (beats.length >= 3) break;
    if (/^EPISODE\s+\d+/i.test(line)) continue;
    if (/^END\s+(OF\s+)?EPISODE/i.test(line)) continue;
    // Skip ALL CAPS character cue headers
    if (/^[A-Z][A-Z0-9\s'\-]{1,40}$/.test(line) && !/[.!?,]/.test(line) && line.length <= 44) continue;
    // Skip standalone parentheticals
    if (/^\([^)]+\)$/.test(line)) continue;
    beats.push(line);
  }
  return beats.join(" ").slice(0, 220);
}

/**
 * Phase 1a — Universal structured opening fingerprint.
 * Extracts {location, action, dialogue_type} from any episode opening.
 * Purely deterministic — no LLM, no genre-specific rules.
 * Used in Phase 1b (stored on recap) and Phase 1c (injected into prompt).
 */
function extractOpeningFingerprint(text) {
  const lines = safeStr(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // ── Location ─────────────────────────────────────────────────────────────
  // Find the first scene heading and strip formatting noise.
  let location = "UNKNOWN";
  for (const line of lines) {
    if (/^(INT|EXT|INT\/EXT|EXT\/INT)[.\s]/i.test(line)) {
      location = line
        .replace(/^(INT|EXT|INT\/EXT|EXT\/INT)[.\s-]*/i, "")  // strip INT./EXT. prefix
        .replace(/[-–—]\s*(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|CONTINUOUS|MOMENTS?\s+LATER|LATER)[^)]*$/i, "") // strip time-of-day suffix
        .replace(/\s+\d+\s*$/, "")   // strip trailing episode/page numbers
        .trim()
        .toUpperCase()
        .slice(0, 60);
      break;
    }
  }

  // ── Action ───────────────────────────────────────────────────────────────
  // Collect the first 5 non-heading, non-cue, non-metadata lines as action lines.
  const actionLines = [];
  let pastHeading = false;
  for (const line of lines) {
    if (actionLines.length >= 5) break;
    if (/^EPISODE\s+\d+/i.test(line) || /^END\s+(OF\s+)?EPISODE/i.test(line)) continue;
    if (/^(INT|EXT|INT\/EXT|EXT\/INT)[.\s]/i.test(line)) { pastHeading = true; continue; }
    if (!pastHeading) continue;
    // Skip ALL CAPS character cue lines
    if (/^[A-Z][A-Z0-9\s'.\-()]{0,50}$/.test(line) && line.length <= 55) continue;
    // Skip parentheticals
    if (/^\([^)]+\)$/.test(line)) continue;
    // Skip dialogue (lines following a cue — heuristic: short, starts lower-case or quoted)
    actionLines.push(line.toLowerCase());
  }
  const actionText = actionLines.join(" ");

  let action = "other";
  if (/\b(pores?\s+over|reads?|studies|studying|traces?\s+the|scrolls?\s+through|flips?\s+through|searches?\s+through|scans?\s+a\s+(page|document|letter|file)|poring\s+over)\b/.test(actionText))
    action = "researching/reading";
  else if (/\b(stands?\s+(at|by|near|over|before|in\s+front)|stands?\s+alone|standing\s+(at|by|over)|gazes?\s+at|stares?\s+at|looks?\s+(out|at|over))\b/.test(actionText))
    action = "standing/observing";
  else if (/\b(walks?\s+(briskly|along|toward|away|through)|strides?|paces?|moves?\s+(through|toward|along)|marches?|approaches?\s+(quietly|slowly|quickly))\b/.test(actionText))
    action = "walking/moving";
  else if (/\b(confronts?|blocks?\s+(her|his|their)\s+path|steps?\s+(in\s+front|between|forward\s+sharply)|faces?\s+each\s+other|squares?\s+off)\b/.test(actionText))
    action = "confronting";
  else if (/\b(fights?|attacks?|lunges?|rushes?|sprints?|runs?|escapes?|dodges?|strikes?|draws?\s+(a\s+)?(weapon|dagger|blade|sword|gun))\b/.test(actionText))
    action = "fighting/action";
  else if (/\b(sits?\s+(at|by|behind|down)|works?\s+at|types?|leans?\s+over|crouches?|kneels?)\b/.test(actionText))
    action = "sitting/working";
  else if (/\b(arrives?|enters?|steps?\s+in(side|to)?|emerges?|appears?\s+(at|from|in\s+the)|walks?\s+in|bursts?\s+(in|through))\b/.test(actionText))
    action = "arriving/entering";
  else if (/\b(waits?|lingers?|pauses?|hesitates?|remains?\s+(still|silent)|stands?\s+in\s+silence)\b/.test(actionText))
    action = "waiting";

  // ── Dialogue type ─────────────────────────────────────────────────────────
  // Find the first dialogue line (line after an ALL CAPS cue).
  let dialogueType = "none";
  let lastWasCue = false;
  for (const line of lines) {
    const isCue = /^[A-Z][A-Z0-9\s'.\-()]{0,50}$/.test(line) && line.length <= 55 &&
                  !/^(INT|EXT|INT\/EXT|EXT\/INT|EPISODE|END\s+EPISODE|FADE|CUT\s+TO|SMASH\s+TO)/i.test(line);
    if (isCue) { lastWasCue = true; continue; }
    if (/^\([^)]+\)$/.test(line)) continue; // parenthetical — keep lastWasCue
    if (!lastWasCue) continue;

    // We have first dialogue line
    const d = line.toLowerCase();
    if (/\b(still\s+chasing|you('re|\s+are)\s+(wasting|wrong|deluded|chasing)|that('s|\s+is)\s+(impossible|ridiculous|insane)|you\s+really\s+think|not\s+this\s+again|give\s+it\s+up|stop\s+chasing)\b/.test(d))
      dialogueType = "skeptic_dismissal";
    else if (/\b(be\s+careful|you('re|\s+are)\s+in\s+danger|stay\s+away|watch\s+your|they('re|\s+are)\s+(coming|watching)|it('s|\s+is)\s+not\s+safe|run\b|get\s+out)\b/.test(d))
      dialogueType = "warning";
    else if (/\b(missed\s+you|good\s+to\s+see|you('re|\s+are)\s+(back|here|finally)|i\s+was\s+looking\s+for\s+you|welcome\s+back|you\s+made\s+it)\b/.test(d))
      dialogueType = "reunion";
    else if (/\b(who\s+are\s+you|state\s+your|what\s+are\s+you\s+doing\s+here|why\s+are\s+you|what\s+do\s+you\s+want|you\s+shouldn't\s+be\s+here|unauthorized)\b/.test(d))
      dialogueType = "challenge/confrontation";
    else if (/\b(we\s+need\s+to|i\s+found\s+(something|it|a)|there('s|\s+is)\s+(a|something|someone)|the\s+(signal|readings?|data|creature|plan|mission))\b/.test(d))
      dialogueType = "exposition";
    else if (/\b(i\s+(love|need|can't\s+stop\s+thinking\s+about|can't\s+lose)|you\s+mean\s+everything|i\s+was\s+wrong\s+about\s+you)\b/.test(d))
      dialogueType = "intimacy/emotional";
    else if (d.trim().endsWith("?"))
      dialogueType = "question";
    else
      dialogueType = "statement";
    break;
  }

  return { location, action, dialogue_type: dialogueType };
}

/**
 * Phase 2a — Structural similarity scorer for episode openings.
 * Compares two fingerprints and returns a 0–1 score.
 *
 * Weights:
 *   location     0.5  — most visible to the audience; same room = instant déjà vu
 *   action       0.3  — same first beat feels like a reset even in a new location
 *   dialogue_type 0.2 — same conversation opener compounds the repetition
 *
 * Location matching is fuzzy: strips numbers, articles, and directional words
 * so "RESEARCH VESSEL DECK 3" and "RESEARCH VESSEL DECK" both score as the same place.
 */
function scoreOpeningSimilarity(fp1, fp2) {
  if (!fp1 || !fp2) return 0;

  // Normalise a location string to its essential noun phrase
  const normLoc = (loc) =>
    safeStr(loc)
      .toUpperCase()
      .replace(/\b(THE|A|AN|LOWER|UPPER|MAIN|INNER|OUTER|NORTH|SOUTH|EAST|WEST|OLD|NEW)\b/g, "")
      .replace(/\b\d+\b/g, "")           // strip floor/room numbers
      .replace(/[-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const loc1 = normLoc(fp1.location);
  const loc2 = normLoc(fp2.location);

  // Exact match after normalisation
  let locScore = 0;
  if (loc1 === loc2 && loc1 !== "UNKNOWN") {
    locScore = 1;
  } else {
    // Partial match: one location string contains the other's core word(s)
    const words1 = new Set(loc1.split(/\s+/).filter((w) => w.length > 3));
    const words2 = new Set(loc2.split(/\s+/).filter((w) => w.length > 3));
    const shared = [...words1].filter((w) => words2.has(w)).length;
    const minSize = Math.min(words1.size, words2.size);
    if (minSize > 0) locScore = shared / minSize;  // 0.5 if half the words match
  }

  const actionScore = fp1.action === fp2.action && fp1.action !== "other" ? 1 : 0;
  const dialogueScore =
    fp1.dialogue_type === fp2.dialogue_type && fp1.dialogue_type !== "none" && fp1.dialogue_type !== "statement"
      ? 1
      : 0;

  return locScore * 0.5 + actionScore * 0.3 + dialogueScore * 0.2;
}

/**
 * Phase 2b — Best-match finder.
 * Runs scoreOpeningSimilarity against every prior episode's stored fingerprint
 * and returns the closest match: { score, episode, fingerprint } or null if
 * no prior recaps have a fingerprint yet.
 */
function findMostSimilarPriorOpening(newFingerprint, recaps) {
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

/**
 * Phase 3a — Blueprint setting match checker.
 * Returns { match: boolean, confidence: 0–1, normalizedSetting: string }
 *
 * Fuzzy: blueprint says "royal throne room", fingerprint extracts "THRONE ROOM" → match.
 * Strategy:
 *   1. Normalise both strings (lowercase, strip articles/filler, split to keywords).
 *   2. Count shared keywords with length > 3.
 *   3. confidence = shared / total keywords in the blueprint setting (recall-oriented:
 *      we only care whether the blueprint's key nouns appear in the opening location,
 *      not whether every word in the location matches the blueprint).
 *   4. match = confidence >= 0.5 OR any single "anchor word" (≥6 chars) appears in both.
 */
function blueprintSettingMatches(openingFingerprint, settingFocus) {
  const empty = { match: true, confidence: 1, normalizedSetting: "" };
  if (!settingFocus || typeof settingFocus !== "string") return empty;
  if (!openingFingerprint || openingFingerprint.location === "UNKNOWN") return empty;

  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "of", "in", "at", "on", "near",
    "inside", "outside", "with", "from", "into", "during", "main",
    "upper", "lower", "inner", "outer", "old", "new", "grand", "royal",
    "int", "ext",
  ]);

  const tokenize = (str) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const settingTokens = tokenize(settingFocus);
  const locationTokens = new Set(tokenize(openingFingerprint.location));

  if (!settingTokens.length) return empty;

  const shared = settingTokens.filter((w) => locationTokens.has(w));
  const confidence = shared.length / settingTokens.length;

  // Anchor word: any single keyword ≥ 6 chars present in both is sufficient for a match
  // (e.g. "library", "throne", "harbour", "palace" are unambiguous anchors)
  const hasAnchor = settingTokens.some((w) => w.length >= 6 && locationTokens.has(w));

  return {
    match: confidence >= 0.5 || hasAnchor,
    confidence,
    normalizedSetting: settingTokens.join(" "),
  };
}

function tagEpisodeEvents(text) {
  const s = safeStr(text).toLowerCase();
  if (!s) return [];
  const tags = new Set();
  const add = (t) => tags.add(t);

  if (/explosion|explode|blast|detonation|bomb\b/.test(s)) add("explosion");
  if (/fire\b|flames?|burning/.test(s)) add("fire");
  if (/elevator|lift shaft|freight elevator/.test(s)) add("elevator_scene");
  if (/warehouse|abandoned factory|storage unit/.test(s)) add("warehouse_scene");
  if (/kidnap|abduct|hostage|tied up|gagged/.test(s)) add("kidnapping");
  if (/car chase|pursuit on the road|screech(es|ed) to a halt/.test(s))
    add("car_chase");
  if (/\bmonster\b|creature|shadow beast|werewolf/.test(s)) add("monster_attack");
  if (/\bkiss(es|ed)?\b|their lips meet|press(es|ed) his lips/.test(s))
    add("strong_kiss");
  if (/gunshot|shots? fired|pulls? the trigger/.test(s)) add("gunfight");
  if (/storm\b|thunder|lightning/.test(s)) add("storm_atmosphere");

  // Opening beat fingerprinting — check first ~600 chars so we tag the OPEN, not mid-episode action.
  const opening = s.slice(0, 600);
  if (
    /\b(dock|beach|water.{0,20}edge|ocean.{0,15}scan|sonar device|notebook.{0,20}ocean|ocean.{0,20}notebook|water.{0,15}scan)\b/.test(opening)
  ) add("dock_beach_scan_open");

  // Library / archive / research-room opening — the most common fantasy/romance repeat pattern
  if (
    /\b(library|archive|royal\s+library|reading\s+room|scriptorium|record\s+room)\b/.test(opening) &&
    /\b(shelf|shelves|bookshelf|bookshelves|tome|tomes|scroll|scrolls|ancient\s+book|dusty|parchment|spine)\b/.test(opening)
  ) add("library_research_open");

  // Skeptic dismissal beat — cold lead's lazy "still chasing ghosts" opener
  if (/still\s+chasing\s+(ghosts?|shadows?|monsters?|those\s+waves|sea\s+monsters?|trouble|fairy\s+tales?|your\s+(monster|creature)|dust|old\s+secrets?|the\s+past)/.test(s)) add("skeptic_dismissal");

  // Creature/threat confirmed as real by direct witness
  if (/it.s real|that.s real|confirmed.{0,30}(creature|monster|threat)|creature.{0,30}confirmed|everyone.{0,30}(saw|witnessed)|all three.{0,30}(saw|watched|confirmed)/.test(s)) add("threat_confirmed");

  return Array.from(tags);
}

function formatRecentEventConstraints(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const allPrev = recaps.filter((r) => typeof r.episode === "number" && r.episode < episodeNumber);
  const recent = allPrev.slice(-6); // expanded from -3
  if (!recent.length) return "";

  const recentTags = new Set();
  const dockScanEps = [];
  const skepticEps = [];
  for (const r of recent) {
    if (Array.isArray(r.tags)) {
      for (const t of r.tags) {
        if (t) recentTags.add(t);
      }
      if (r.tags.includes("dock_beach_scan_open")) dockScanEps.push(r.episode);
      if (r.tags.includes("skeptic_dismissal")) skepticEps.push(r.episode);
    }
  }

  // All-time tag counts (not just recent window) for patterns that should NEVER repeat freely
  const allTimeEpsWithTag = (tag) =>
    allPrev.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag)).map((r) => r.episode);

  const parts = [];

  // Standard big set-piece avoidance (exclude the new opening/relationship tags — handled separately)
  const excludedTags = ["dock_beach_scan_open", "skeptic_dismissal", "threat_confirmed", "library_research_open"];
  const setpieceTags = Array.from(recentTags).filter((t) => !excludedTags.includes(t));
  if (setpieceTags.length) {
    parts.push(
      "RECENT BIG SET-PIECES (avoid repeating as the main device this episode): " +
      setpieceTags.join(", ") + "."
    );
  }

  // Dock/beach scan ban — if used ≥2 times in the recent window
  if (dockScanEps.length >= 2) {
    parts.push(
      `OPENING BEAT BANNED: Do NOT open this episode with the heroine standing alone at the dock, beach, or water's edge scanning the ocean or checking equipment. ` +
      `That exact beat was used in recent episodes (${dockScanEps.join(", ")}). ` +
      `Start somewhere completely different — indoors, mid-action, mid-conversation, or from a secondary character's perspective.`
    );
  }

  // Library/archive opening ban — ≥3 uses all-time is clearly a crutch; ban it hard
  const libraryEpsAll = allTimeEpsWithTag("library_research_open");
  if (libraryEpsAll.length >= 3) {
    parts.push(
      `OPENING LOCATION BANNED (library overused): The library, archive, or research room has been used as an episode opening ${libraryEpsAll.length} times (eps ${libraryEpsAll.slice(-5).join(", ")}). ` +
      `Do NOT open this episode in any room full of books, scrolls, or tomes. ` +
      `Choose a completely different location — outdoor setting, a battlefield, a court chamber, a personal room, a market, or a new location introduced by this episode's blueprint plan.`
    );
  } else if (libraryEpsAll.length >= 1) {
    // Softer warning before the hard ban
    parts.push(
      `OPENING CAUTION: The library/archive has already been used as an opening setting in episode(s) ${libraryEpsAll.join(", ")}. ` +
      `Strongly prefer a different opening location this episode.`
    );
  }

  // Skeptic dismissal ban — "still chasing ghosts?" must NEVER repeat; ban after any single use
  const skepticAllEps = allTimeEpsWithTag("skeptic_dismissal");
  if (skepticAllEps.length >= 1) {
    parts.push(
      `DIALOGUE PERMANENTLY BANNED: Do NOT use any variation of "still chasing ghosts/shadows/monsters/ghosts in dusty books?" as the cold male lead's opening line. ` +
      `That dismissive line was already used in episode(s) ${skepticAllEps.join(", ")} and must never appear again in this series. ` +
      `He must open with something fresh — urgency, strategy, grudging respect, new information, or a direct challenge.`
    );
  }

  // Locked confirmed facts — inject once threat has been directly witnessed
  const threatConfirmedEp = allPrev.find((r) => Array.isArray(r.tags) && r.tags.includes("threat_confirmed"));
  if (threatConfirmedEp) {
    parts.push(
      `LOCKED SERIES FACT (established in episode ${threatConfirmedEp.episode}, cannot be undone): ` +
      `The threat/creature was directly witnessed and confirmed real by the main characters. ` +
      `No character may question whether it exists or treat it as rumor/imagination from this point forward. ` +
      `Reactions must be tactical, protective, or fear-based — NOT dismissive.`
    );
  }

  // Explicit opening beat ban — show the model the actual text of recent episode openings
  // so it cannot default to the same console/signal/approach structure episode after episode.
  const openingBeats = allPrev
    .slice(-10)
    .filter((r) => r.openingBeat && typeof r.openingBeat === "string" && r.openingBeat.length > 20)
    .map((r) => `  Ep ${r.episode}: "${r.openingBeat.slice(0, 160)}"`)
    .filter(Boolean);
  if (openingBeats.length >= 2) {
    parts.push(
      "FORBIDDEN OPENING STRUCTURES — the following are the ACTUAL OPENINGS already used in prior episodes.\n" +
      "Do NOT start this episode with the same location, the same first character action, or the same beat type " +
      "(e.g. character at a console/screen, signal/readings discussion, someone approaching from behind).\n" +
      "Write an opening the audience has not seen before:\n" +
      openingBeats.join("\n")
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------

const V2_SYSTEM_PROMPT = `You are a vertical episode writer for short-form / vertical dramas.

The user sends you a JSON object that describes one episode:
- episode number, total_episodes_for_show, arc_phase (hook / escalation / lock_in / spin_out)
- protagonist_type, core_theme, content_rating
- logline (season summary)
- scenes: list of scene_id, location, beat_type, characters

You MUST respond with ONLY a JSON array of blocks. Each block: block_id, episode, scene_id, type ("action" or "dialogue"), speaker (ALL CAPS for dialogue, null for action), text.

Follow the plan, write vivid action and natural dialogue. Strong hook in the first blocks, end on a cliffhanger or question. No commentary—only the JSON array.`;

function arcPhase(ep, total) {
  if (ep <= 0) return "unknown";
  if (ep <= 3) return "hook";
  if (ep <= 7) return "escalation";
  if (ep <= 21) return "lock_in";
  return "spin_out";
}

function buildEpisodeInput(ep, total, logline, genre) {
  const isWerewolf = (genre || "").toUpperCase() === "WEREWOLF";
  const phase = arcPhase(ep, total);
  return {
    show_id: "generated",
    episode: ep,
    total_episodes_for_show: total,
    arc_phase: phase,
    cliffhanger_flag: true,
    hook_profile: { visual_3s: true, theme_7s: true, emotion_21s: true },
    protagonist_type: "underdog_female",
    core_theme: isWerewolf ? "werewolf_curse" : "forbidden_romance",
    content_rating: "PG-13",
    logline: (logline || "").trim().slice(0, 1500),
    scenes: [
      { scene_id: `E${ep}_S1`, location: "INT. LOCATION - DAY", beat_type: "generic_drama", arc_phase: phase, characters: null },
      { scene_id: `E${ep}_S2`, location: "INT. / EXT. - DAY OR NIGHT", beat_type: "generic_drama", arc_phase: phase, characters: null },
    ],
  };
}

function safeStr(val) {
  if (val == null) return "";
  if (typeof val === "string") return val.trim();
  return String(val).trim();
}

function estimatePromptTokens(text) {
  // Approximate for telemetry only (English-heavy prompts).
  const s = safeStr(text);
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

function titleCaseName(name) {
  const s = safeStr(name);
  if (!s) return s;
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => {
      const parts = w.split("-");
      return parts
        .map((p) =>
          p ? p[0].toUpperCase() + (p.length > 1 ? p.slice(1) : "") : p
        )
        .join("-");
    })
    .join(" ");
}

function normalizeNameKeyLoose(name) {
  return safeStr(name)
    .replace(/[’]/g, "'")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function levenshteinDistance(a, b) {
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
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[n][m];
}

function nameSimilarity(a, b) {
  const na = normalizeNameKeyLoose(a);
  const nb = normalizeNameKeyLoose(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 0 : 1 - dist / maxLen;
}

function extractAllCapsCueLines(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    // Character cue-ish: ALL CAPS name with optional parenthetical.
    if (!/^[A-Z0-9 '\-]+(?:\s*\([^)]*\))?$/.test(trimmed)) continue;
    if (/[.!?]/.test(trimmed)) continue;
    if (trimmed.length > 60) continue;
    out.push(trimmed);
  }
  return out;
}

function extractCueBaseNameFromHeaderLine(line) {
  let s = String(line || "").trim();
  const parenIdx = s.indexOf("(");
  if (parenIdx >= 0) s = s.slice(0, parenIdx).trimEnd();
  // Drop POV suffix from base.
  s = s.replace(/\s+POV$/i, "").trimEnd();
  // Drop possessive for base-key matching.
  s = s.replace(/('S|'s)$/i, "").trimEnd();
  return s;
}

function detectMainTrioNameMismatches(episodeText, names) {
  if (!episodeText || typeof episodeText !== "string") return [];
  if (!names) return [];

  const expected = [
    { key: normalizeNameKeyLoose(names.heroine), header: String(names.heroine).toUpperCase(), prose: titleCaseName(names.heroine), canonicalKey: "HEROINE" },
    { key: normalizeNameKeyLoose(names.coldCeo), header: String(names.coldCeo).toUpperCase(), prose: titleCaseName(names.coldCeo), canonicalKey: "MALE1" },
    { key: normalizeNameKeyLoose(names.warmFriend), header: String(names.warmFriend).toUpperCase(), prose: titleCaseName(names.warmFriend), canonicalKey: "MALE2" },
  ].filter((x) => x.key);

  if (!expected.length) return [];

  const cueLines = extractAllCapsCueLines(episodeText);
  const mismatches = [];

  for (const cueLine of cueLines) {
    const base = extractCueBaseNameFromHeaderLine(cueLine);
    const cueKey = normalizeNameKeyLoose(base);
    if (!cueKey) continue;

    for (const ex of expected) {
      if (cueKey === ex.key) continue;
      const sim = nameSimilarity(cueKey, ex.key);
      if (sim >= 0.92) {
        mismatches.push({
          expectedCanonicalKey: ex.canonicalKey,
          expectedHeader: ex.header,
          foundVariant: cueLine,
          locationHint: "cue header line",
        });
      }
    }
  }

  // Deduplicate by foundVariant.
  const seen = new Set();
  return mismatches.filter((m) => {
    const k = m.expectedCanonicalKey + "::" + m.foundVariant;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Directly fixes detected main-trio name variants in cue header lines.
 * Previously detection logged mismatches but never applied corrections — this is the fix.
 */
function applyMainTrioNameCorrections(episodeText, mismatches) {
  if (!mismatches || !mismatches.length || !episodeText) return episodeText;
  const lines = String(episodeText).split(/\r?\n/);
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    // Only operate on lines that look like character cue headers (ALL CAPS, optional parens)
    if (!/^[A-Z0-9 '\-]+(?:\s*\([^)]*\))?$/.test(trimmed)) return line;
    if (/[.!?]/.test(trimmed) || trimmed.length > 60) return line;
    // Extract base name (strip parenthetical, POV suffix, possessive)
    let base = trimmed;
    const parenIdx = base.indexOf("(");
    if (parenIdx >= 0) base = base.slice(0, parenIdx).trimEnd();
    base = base.replace(/\s+POV$/i, "").trimEnd();
    base = base.replace(/('S|'s)$/i, "").trimEnd();
    if (!base) return line;
    for (const mm of mismatches) {
      const variant = String(mm.foundVariant || "").trim();
      const expected = String(mm.expectedHeader || "").trim();
      if (!variant || !expected || variant === expected) continue;
      if (base === variant) {
        return line.replace(variant, expected);
      }
    }
    return line;
  }).join("\n");
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

async function validateMainTrioNameConsistencyWithLLM({
  episodeText,
  names,
  episodeNumber,
}) {
  if (!names) return null;
  const expected = [
    { expectedCanonicalKey: "HEROINE", expectedHeader: String(names.heroine).toUpperCase(), expectedProse: titleCaseName(names.heroine) },
    { expectedCanonicalKey: "MALE1", expectedHeader: String(names.coldCeo).toUpperCase(), expectedProse: titleCaseName(names.coldCeo) },
    { expectedCanonicalKey: "MALE2", expectedHeader: String(names.warmFriend).toUpperCase(), expectedProse: titleCaseName(names.warmFriend) },
  ];

  const cueLines = extractAllCapsCueLines(episodeText);
  const payload = cueLines.slice(0, 120); // cap to avoid token bloat

  const validation = await openai.chat.completions.create({
    model: NAME_VALIDATION_MODEL,
    messages: [
      { role: "system", content: NAME_CONSISTENCY_VALIDATION_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `EPISODE_NUMBER: ${episodeNumber}\n` +
          `EXPECTED_CANONICAL_NAMES:\n` +
          JSON.stringify(expected) +
          `\n\nCUE_LINES:\n` +
          payload.join("\n"),
      },
    ],
    max_tokens: 320,
    temperature: 0.2,
    frequency_penalty: 1.0,
    presence_penalty: 0.2,
  });

  const raw = validation.choices?.[0]?.message?.content;
  const json = extractJsonObject(raw);
  return json;
}

/** Words that are all-caps in action lines but must not be treated as character names when splitting merged cues. */
const MERGE_SPLIT_NAME_BLOCKLIST = new Set(
  [
    "AND",
    "THE",
    "BUT",
    "FOR",
    "NOT",
    "NOW",
    "ALL",
    "CAN",
    "HER",
    "HIS",
    "ITS",
    "OUR",
    "OUT",
    "OFF",
    "SHE",
    "THEY",
    "THEM",
    "THEN",
    "THAN",
    "THIS",
    "THAT",
    "THERE",
    "THESE",
    "THOSE",
    "WHAT",
    "WHEN",
    "WITH",
    "FROM",
    "INTO",
    "OVER",
    "UNDER",
    "ABOVE",
    "AFTER",
    "BEFORE",
    "WHILE",
    "DURING",
    "SUDDENLY",
    "SLOWLY",
    "FINALLY",
    "MEANWHILE",
    "WITHOUT",
    "INSIDE",
    "OUTSIDE",
    "BEHIND",
    "BESIDE",
    "ACROSS",
    "AROUND",
    "AGAINST",
    "THROUGH",
    "TOWARD",
    "EVERYONE",
    "SOMEONE",
    "SOMETHING",
    "NOTHING",
    "EVERYWHERE",
    "SILENCE",
    "FOOTSTEPS",
    "CHAOS",
    "BACK",
    "JUST",
    "ONLY",
    "EVEN",
    "STILL",
    "ALSO",
    "VERY",
    "MORE",
    "MOST",
    "SOME",
    "MANY",
    "MUCH",
    "SUCH",
    "INT",
    "EXT",
  ].map((w) => w.toUpperCase())
);

/**
 * Repairs common model mistakes: character cue glued to parenthetical or dialogue (e.g. LUKESorry, LUKE(mocking)Well).
 * Preserves intentional lines (scene headings, most action).
 */
function normalizeEpisodeScriptFormatting(text) {
  if (!text || typeof text !== "string") return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const raw of lines) {
    const m = raw.match(/^(\s*)(.*)$/);
    const indent = m ? m[1] : "";
    let rest = m ? m[2] : raw;
    let guard = 0;
    while (rest && guard++ < 10) {
      const t = rest.trimStart();
      const leadWs = rest.slice(0, rest.length - t.length);
      if (
        /^(INT\.|EXT\.|INT\/|EXT\/|I\/E\.|EST\.|FADE\s|CUT\s|DISSOLVE|END\s+OF\s+EPISODE|EPISODE\s+\d+)/i.test(
          t
        )
      ) {
        break;
      }
      // NAME(parenthetical)Dialogue — missing line breaks
      const parenMerge = t.match(/^([A-Z][A-Z0-9'\-]{1,20})(\([^)]+\))\s*(.+)$/);
      if (parenMerge && parenMerge[3].trim()) {
        const name = parenMerge[1].toUpperCase();
        if (!MERGE_SPLIT_NAME_BLOCKLIST.has(name)) {
          out.push(indent + leadWs + name);
          out.push(indent + leadWs + parenMerge[2]);
          rest = indent + leadWs + parenMerge[3].trimStart();
          continue;
        }
      }
      // NAME + DialogueWord (no space): LUKE + Sorry…
      const capMerge = t.match(/^([A-Z][A-Z0-9'\-]{1,20})([A-Z][a-z]{2,}[^\n]*)$/);
      if (capMerge) {
        const name = capMerge[1].toUpperCase();
        const dialogue = capMerge[2];
        if (!MERGE_SPLIT_NAME_BLOCKLIST.has(name) && name.length >= 2 && name.length <= 22) {
          out.push(indent + leadWs + name);
          rest = indent + leadWs + dialogue;
          continue;
        }
      }
      break;
    }
    out.push(rest || raw);
  }
  return out.join("\n");
}

/** "EPISODE 12" / common model typos — not real scene headings; app adds canonical markers when streaming. */
const SYNTHETIC_EPISODE_HEADING =
  /^\s*EP(?:ISODE|OSODE|ISDE|OSDE)\s+(\d+)\s*$/i;

function syntheticEpisodeNumberFromLine(line) {
  const m = String(line || "").trim().match(SYNTHETIC_EPISODE_HEADING);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Removes duplicate episode headings, END markers, and truncates when the model
 * packs multiple episode blocks into one response (e.g. EPISODE 27 … EPISODE 28 …).
 */
function stripEpisodeStructuralNoise(text, expectedEpisodeNumber) {
  if (!text || typeof text !== "string") return text;
  let lines = text.replace(/\r\n/g, "\n").split("\n");

  const spillIdx = lines.findIndex((raw) => {
    const n = syntheticEpisodeNumberFromLine(raw);
    return n != null && n > expectedEpisodeNumber;
  });
  if (spillIdx >= 0) {
    lines = lines.slice(0, spillIdx);
  }

  lines = lines.filter((raw) => syntheticEpisodeNumberFromLine(raw) == null);

  const standaloneEnd = /^\s*END\s+OF\s+(?:EPISODE|EPOSODE|EPISODES?|EPODES)\b/i;
  lines = lines.filter((l) => !standaloneEnd.test(l));

  const inlineEnd =
    /\s*\(\s*END\s+OF\s+(?:EPISODE|EPOSODE|EPISODES?|EPODES)\b[^)]*\)\s*$/i;
  lines = lines.map((l) => l.replace(inlineEnd, "").trimEnd());

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Heuristic repair for LLM token-boundary failures (enteringthe, Lucasthis, etc.).
 * Skips scene headings, episode markers, and short ALL-CAPS slug lines.
 */
function shouldSkipMergedWordFix(trimmed) {
  const t = trimmed.trim();
  if (!t) return true;
  if (/^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(t)) return true;
  if (/^EPISODE\s+\d/i.test(t)) return true;
  if (/^(FADE\s|CUT\s|DISSOLVE\b)/i.test(t)) return true;
  if (/^ONSCREEN\b/i.test(t)) return false;
  // Short slug-only lines (names, transitions in caps)
  if (!/[a-z]/.test(t) && t.length <= 48) return true;
  return false;
}

function fixMergedWordSpacingInLine(line) {
  const m = line.match(/^(\s*)(.*)$/);
  const indent = m ? m[1] : "";
  let body = m ? m[2] : line;
  const trimmed = body.trim();
  if (!trimmed || shouldSkipMergedWordFix(trimmed)) return line;

  let t = body;
  t = t.replace(/([a-z])([A-Z])/g, "$1 $2");
  t = t.replace(/([.!?])([A-Z])/g, "$1 $2");
  t = t.replace(/([,;:])([A-Za-z])/g, "$1 $2");
  t = t.replace(/\bhisthere's\b/gi, "his there's");
  t = t.replace(/\bhisthere\b/gi, "his there");

  const glued = [
    [/\benteringthe\b/gi, "entering the"],
    [/\bnearbythe\b/gi, "nearby the"],
    [/\bsharplyand\b/gi, "sharply and"],
    [/\bcloseragain\b/gi, "closer again"],
    [/\bagainabout\b/gi, "again about"],
    [/\btogetherthen\b/gi, "together then"],
    [/\bLucasthis\b/gi, "Lucas this"],
    [/\bstiffensher\b/gi, "stiffens her"],
    [/\bherselfconsciously\b/gi, "herself consciously"],
    [/\bsomeoneelse\b/gi, "someone else"],
    [/\bwithoutwarning\b/gi, "without warning"],
    [/\bfrombehind\b/gi, "from behind"],
    [/\belsein\b/gi, "else in"],
    [/\bdresseda\b/gi, "dressed a"],
    [/\btoithis\b/gi, "to it his"],
    [/\bforithis\b/gi, "for it his"],
  ];
  for (const [re, rep] of glued) t = t.replace(re, rep);

  t = t.replace(/ {2,}/g, " ");
  return indent + t;
}

function fixMergedWordsEpisodeText(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .split(/\r?\n/)
    .map((ln) => fixMergedWordSpacingInLine(ln))
    .join("\n");
}

function hasMergedWordIssues(text) {
  if (!text || typeof text !== "string") return false;
  const report = auditMergedWords(text);
  // Trigger retry if more than 1 merged word remains after post-processing.
  return report.totals.mergedTotal > 1;
}

const PROMPT_LEAK_LINE_PATTERNS = [
  /\bEND\s+OF\s+PREVIOUS\s+EPISODE\b/i,
  /\bWrite\s+episode\s+\d+\s+now\b/i,
  /\bcontinuing\s+directly\b/i,
  /\bline\s+spacing\s+separator\b/i,
  /\bmarking\s+transition\b/i,
  /\bCONTINUATION\s+REQUIREMENT\b/i,
  /\bCHARACTER\s+MANIFEST\b/i,
  /\bDo\s+NOT\s+output\b/i,
  /\bOutput\s+only\b.*\b(script|screenplay|content)\b/i,
  /\[\[\s*INTERNAL_CONTEXT_(?:BEGIN|END)\s*\]\]/i,
  /\[\[\s*DO_NOT_OUTPUT_INTERNAL_CONTEXT\s*\]\]/i,
  /\[\[\s*STORY_STATE_(?:BEGIN|END)\s*\]\]/i,
  /\[\[\s*DO_NOT_OUTPUT_STORY_STATE\s*\]\]/i,
  /\btoken\s+limit\b/i,
  /\bconversation\s+history\b/i,
  /\bmemory\s+retention\b/i,
  /\bsystem\s+messages?\b/i,
  /\bformatting\s+conventions?\b/i,
  /\bfont\s+size\s+style\b/i,
  /\bpage\s+number\s+line\s+spacing\b/i,
  /\binternal\s+context\s+markers?\b/i,
  /\bexplicit\s+content\s+disclaimers?\b/i,
  /\bcall-to-action\s+instructions?\b/i,
  /\bindustry\s+formatting\b/i,
];

function isMessyEpisodeDivider(line) {
  const t = String(line || "").trim();
  if (!t) return false;
  if (/^(?:-\d+\s+){2,}EP(?:ISODE|OSODE|ISDE|ODES?)\s*\d+/i.test(t)) return true;
  if (/^-{2,}\s*EP(?:ISODE|OSODE|ISDE|ODES?)\s*\d+/i.test(t)) return true;
  if (/^-{2,}\s*$/.test(t)) return true;
  return false;
}

function sanitizeEpisodePromptLeaks(text, episodeNumber) {
  if (!text || typeof text !== "string") return { text, stripped: [] };
  const stripped = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) {
      kept.push(raw);
      continue;
    }

    if (PROMPT_LEAK_LINE_PATTERNS.some((re) => re.test(t))) {
      stripped.push({ line: i + 1, reason: "prompt_leak", text: t.slice(0, 220) });
      continue;
    }

    if (isMessyEpisodeDivider(t)) {
      stripped.push({ line: i + 1, reason: "dash_separator_noise", text: t.slice(0, 220) });
      continue;
    }

    // Remove explicit episode wrappers if model leaks them; pipeline adds canonical wrappers.
    if (/^\s*EP(?:ISODE|OSODE|ISDE|ODES?)\s+\d+\s*$/i.test(t)) {
      stripped.push({ line: i + 1, reason: "episode_heading_noise", text: t });
      continue;
    }
    if (/^\s*END\s+(?:OF\s+)?EP(?:ISODE|OSODE|ISDE|ODES?)\s+\d+\s*$/i.test(t)) {
      stripped.push({ line: i + 1, reason: "episode_end_noise", text: t });
      continue;
    }

    kept.push(raw);
  }

  let cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) cleaned = `[Episode ${episodeNumber} content unavailable]`;

  // Canonical wrappers required by Phase 2.
  cleaned = `EPISODE ${episodeNumber}\n\n${cleaned}\n\nEND EPISODE ${episodeNumber}`;
  return { text: cleaned, stripped };
}

function finalizeEpisodeText(text, episodeNumber, names = null) {
  if (!text || typeof text !== "string") return text;
  // Phase 2 sequential normalisation:
  // 1) Strip prompt/meta leaks and enforce canonical EPISODE / END EPISODE wrappers
  // 2) Fix END EPISODE newline swallow + lowercase→uppercase boundary merges
  // 3) Strip structural noise and apply other spacing/line-break repairs.
  const sanitized = sanitizeEpisodePromptLeaks(text, episodeNumber);
  if (sanitized.stripped.length) {
    console.warn(
      `Sanitizer stripped ${sanitized.stripped.length} leak/noise lines in episode ${episodeNumber}:`,
      sanitized.stripped.slice(0, 12)
    );
  }
  const characterNames = names
    ? [names.heroine, names.coldCeo, names.warmFriend].filter(Boolean)
    : [];
  const mergeNorm = fixMergedWordIssuesPhase2Detailed(sanitized.text, {
    dynamicPatterns: DYNAMIC_MERGE_PATTERNS,
    characterNames,
  });
  let t = mergeNorm.text;
  if (!mergeNorm.idempotent || mergeNorm.logs.some((x) => x.count > 0)) {
    console.warn(`Merge normalizer metrics episode ${episodeNumber}:`, mergeNorm.logs);
  }
  t = stripEpisodeStructuralNoise(t, episodeNumber);
  t = fixMergedWordsEpisodeText(t);
  const normalized = normalizeEpisodeScriptFormatting(t).trim();
  return `EPISODE ${episodeNumber}\n\n${normalized
    .replace(/^\s*EP(?:ISODE|OSODE|ISDE|ODES?)\s+\d+\s*/i, "")
    .replace(/\s*END\s+EP(?:ISODE|OSODE|ISDE|ODES?)\s+\d+\s*$/i, "")
    .trim()}\n\nEND EPISODE ${episodeNumber}`;
}

/** Collapse detection: technical word-vomit vs philosophical / abstract prose (thin-genre failures). */
const COLLAPSE_TECH_LEXICON =
  /\b(geology|chemistry|physics|quantum|blockchain|algorithm|nucleosynthesis|pharmacogenomics|ontology|epistemology|topology|astrophysics|biochemistry)\b/i;

const COLLAPSE_ABSTRACT_LEXICON =
  /\b(forevermore|eternity|destiny|cosmos|existence|metaphysics|consciousness|transcend(?:s|ed|ing)?|infinite|eternal|universal|omnipotent|inevitably|perpetually|ceaselessly|endlessly|boundless|immutable|wholeheartedly|willingly|embraced)\b/i;

function lineHasCollapseLexicon(line) {
  return COLLAPSE_TECH_LEXICON.test(line) || COLLAPSE_ABSTRACT_LEXICON.test(line);
}

/**
 * Detects "synonym vomit" / word-list drafts: long runs of punctuation-free
 * single words or huge adjective chains with no normal screenplay structure.
 */
function looksLikeSynonymVomit(text) {
  if (!text || typeof text !== "string") return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;

  // 1) Run of punctuation-free single-word lines.
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

  // 2) Extremely long punctuation-free word chains.
  for (const line of lines) {
    if (/[.!?;,:]/.test(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length >= 12 && words.every((w) => /^[A-Za-z][A-Za-z'-]{1,}$/.test(w))) {
      return true;
    }
  }

  return false;
}

function hasSentenceLevelMerges(text) {
  if (!text || typeof text !== "string") return false;
  // Detect collapsed sentence-like tokens, e.g. "Bloodspurtsoutwardashecollaps".
  const words = text.split(/\s+/).filter(Boolean);
  return words.some((w) => w.length > 25 && /^[A-Za-z]+$/.test(w));
}

function hasQualityCollapse(text, names = null) {
  return (
    looksLikeSynonymVomit(text) ||
    looksLikeContextCollapse(text, names) ||
    hasSentenceLevelMerges(text)
  );
}

function buildNameAnchors(names) {
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
    const isCue = /^[A-Z][A-Z0-9 '\-]{1,30}$/.test(line) && !/^(EPISODE|END EPISODE|FADE|CUT)/i.test(line);
    const hasName = nameAnchors.some((n) => n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line));
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

  // Secondary guard: one giant abstract run line.
  return lines.some((line) => {
    const words = line.split(/\s+/).filter(Boolean);
    return (
      (words.length >= 28 || (lineHasCollapseLexicon(line) && words.length >= 12)) &&
      !/^(INT\.|EXT\.)/i.test(line) &&
      !/[.!?]/.test(line)
    );
  });
}

function splitScenesForAnchorValidation(text) {
  const lines = safeStr(text).split(/\r?\n/);
  const scenes = [];
  let current = null;
  const isHeading = (line) => /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(line.trim());
  for (const raw of lines) {
    const line = safeStr(raw);
    if (!line) continue;
    if (isHeading(line)) {
      if (current) scenes.push(current);
      current = { heading: line, lines: [] };
      continue;
    }
    if (!current) current = { heading: "IMPLIED SCENE", lines: [] };
    current.lines.push(line);
  }
  if (current) scenes.push(current);
  return scenes;
}

function buildSceneAnchors(names) {
  const out = new Set();
  const addName = (full) => {
    const s = safeStr(full);
    if (!s) return;
    out.add(s.toLowerCase());
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts[0]) out.add(parts[0].toLowerCase());
    if (parts.length > 1 && parts[parts.length - 1]) out.add(parts[parts.length - 1].toLowerCase());
  };
  addName(names?.heroine);
  addName(names?.coldCeo);
  addName(names?.warmFriend);
  return [...out];
}

function validateSceneAnchors(episodeText, names) {
  const scenes = splitScenesForAnchorValidation(episodeText);
  const nameAnchors = buildSceneAnchors(names);
  const actionVerbRe =
    /\b(steps?|walks?|turns?|looks?|stares?|grabs?|holds?|opens?|closes?|leans?|nods?|shakes?|runs?|sits?|stands?|moves?|whispers?|says?|asks?|answers?|breathes?|freezes?|reaches?)\b/i;
  const failures = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const sceneText = [s.heading, ...s.lines].join("\n");
    const hasName = nameAnchors.some((n) =>
      new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sceneText)
    );
    const hasActionVerb = actionVerbRe.test(sceneText);
    if (!hasName || !hasActionVerb) {
      failures.push({
        sceneIndex: i + 1,
        heading: s.heading,
        hasName,
        hasActionVerb,
      });
    }
  }
  return {
    sceneCount: scenes.length,
    failureCount: failures.length,
    failures,
    pass: failures.length === 0,
  };
}

async function rewriteEpisodeForAnchors({
  userContent,
  episodeText,
  episodeNumber,
  totalEpisodes,
  names,
}) {
  const anchorPrompt =
    userContent +
    "\n\nANCHOR ENFORCEMENT REWRITE:\n" +
    `This is episode ${episodeNumber} of ${totalEpisodes}. Rewrite the episode so that every scene includes:\n` +
    "- At least one canonical main-character name mention (heroine or one of the two male leads).\n" +
    "- At least one concrete action verb in action lines.\n" +
    "- Keep screenplay formatting and continuity; do not output lists or abstract vocabulary runs.\n\n" +
    "Current draft to fix:\n\n" +
    episodeText;
  const completion = await openai.chat.completions.create({
    model: FINETUNED_MODEL,
    messages: [
      { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
      { role: "user", content: anchorPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.4,
    frequency_penalty: 0.9,
    presence_penalty: 0.4,
  });
  const out = completion.choices?.[0]?.message?.content;
  return typeof out === "string" ? out.trim() : "";
}

function blocksToScriptText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  const lines = [];
  let lastScene = null;
  for (const b of blocks) {
    const sceneId = safeStr(b.scene_id);
    if (sceneId && sceneId !== lastScene) {
      const loc = safeStr(b.location) || "INT. SCENE - DAY";
      lines.push(loc.startsWith("INT") || loc.startsWith("EXT") ? loc : `INT. ${loc} - DAY`);
      lastScene = sceneId;
    }
    const type = safeStr(b.type || b.block_type || "action").toLowerCase();
    const text = safeStr(b.text);
    if (!text) continue;
    if (type === "dialogue" && (b.speaker != null && b.speaker !== "")) {
      lines.push(safeStr(b.speaker).toUpperCase() || "CHARACTER");
      lines.push(text);
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n");
}

// Editor prompt to gently reshape finales / endings toward resolution.
const ENDING_EDIT_SYSTEM_PROMPT = `You are an experienced story editor for serialized vertical romance dramas.

Your sole task is to lightly EDIT the episode script you are given so that the ENDING lands as a satisfying resolution instead of a cliffhanger.

Rules:
- Keep the overall episode structure, tone, and key events the same; do NOT rewrite the whole story from scratch.
- Focus almost entirely on the FINAL SCENE and the LAST 3–6 PARAGRAPHS.
- Remove or rewrite any lingering cliffhanger-style beats (new threats, "this has only begun", "someone watches from the shadows", surprise powerful figures introduced in the last scene, or teaser questions).
- Do NOT introduce any brand-new villains, bosses, institutions, or mysterious figures in the final scene.
- Make sure the last scene clearly LOWERS immediate danger and shows safety, acceptance, or a chosen future for the heroine and her relationships.
- The LAST LINE must feel like a complete, satisfying ending for this season (quiet moment, hopeful plan, or emotionally grounded closure), not a teaser.

Output:
- Return the FULL edited episode script in the same format (scene headings, dialogue, and action lines), but with the ending adjusted to satisfy the rules above.
- Preserve mandatory screenplay line breaks: scene headings and character cues on their own lines; never concatenate a character name with dialogue or parentheticals on one line.
- Do NOT add commentary or explanation—only the edited script.`;

// Simple repetition score between two episode scripts.
// Splits into sentences, normalises, and computes overlap ratio.
function repetitionScore(currentText, previousText) {
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

/**
 * Long verbatim overlap between the end of the previous episode and this draft
 * (models often re-paste the same POV / reaction block after a cliffhanger).
 */
function maxTailBlockOverlap(prevText, curText) {
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

function parseBlocksFromContent(content) {
  const raw = (content || "").trim();
  const jsonMatch = raw.match(/\s*(\[[\s\S]*\])\s*$/);
  const str = jsonMatch ? jsonMatch[1] : raw;
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

const SCRIPT_TRANSLATION_SYSTEM_PROMPT = `You are a professional screenplay translator for short-form vertical dramas.

You will receive ONE episode of an English script. Translate it into Simplified Chinese (简体中文).

Rules:
- Output ONLY the translated script for this episode. No preamble, notes, or markdown.
- Preserve line breaks and blank lines: the output should have the same paragraph structure as the input.
- Keep scene headings in standard English abbreviations (INT., EXT., DAY, NIGHT, CONTINUED, CUT TO:, FADE IN/OUT, V.O., O.S., etc.). You may translate the location name within a scene heading, but keep the INT./EXT. prefix and DAY/NIGHT suffix in English.
- Keep CHARACTER NAMES in ALL CAPS exactly as in the source (same spelling). Translate dialogue, action lines, and parentheticals into natural Simplified Chinese.
- CRITICAL — episode structure markers: keep the following lines in English exactly as they appear in the source. Do NOT translate, rephrase, or omit them:
  • Lines that begin with "EPISODE" followed by a number (e.g. "EPISODE 1", "EPISODE 7") — copy verbatim.
  • Lines that begin with "END EPISODE" followed by a number (e.g. "END EPISODE 1", "END EPISODE 7") — copy verbatim.
- Preserve emotional tone and subtext of dialogue (make it sound natural spoken Chinese drama, not stiff or overly literal).
- Do not add or remove scenes, lines, or episode markers.`;

async function translateEpisodeScriptToChinese(episodeNumber, totalEpisodes, englishText, { retries = 3, retryDelayMs = 4000 } = {}) {
  const src = safeStr(englishText);
  if (!src) return "";
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: TRANSLATION_MODEL,
        messages: [
          { role: "system", content: SCRIPT_TRANSLATION_SYSTEM_PROMPT },
          {
            role: "user",
            content: `This is episode ${episodeNumber} of ${totalEpisodes}.\n\n${src}`,
          },
        ],
        max_tokens: 4096,
        temperature: 0.35,
      });
      const out = completion.choices?.[0]?.message?.content;
      return typeof out === "string" ? out.trim() : "";
    } catch (err) {
      lastErr = err;
      const isRateLimit = err?.status === 429 && !/insufficient_quota/i.test(err?.message || "");
      // Only retry on transient rate limits, not hard quota or other errors
      if (isRateLimit && attempt < retries) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        console.warn(`Translation rate-limited on episode ${episodeNumber}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})…`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Plain-text episode generation (no JSON parsing) ---------------------------

const EPISODE_TEXT_SYSTEM_PROMPT = `You are a vertical drama scriptwriter focused on female-led romance dramas.

The user will give you control tags (language, genre, total episode count, episode index), a short series summary, and THREE MAIN CHARACTER NAMES via tags like:
[HEROINE=...] [MALE1=...] [MALE2=...]

This is always ONE SINGLE SERIES told over many episodes. All  episodes in the run must share:
- The same heroine (female protagonist), the same two main male leads, the same supporting cast names.
- A continuous plot line with clear beginning, middle, and end across the whole season.
- Stable relationships and history between characters that evolve, but are never reset or forgotten.
- The protagonists NEVER get replaced: do NOT switch to a new set of main characters mid-season. You may introduce supporting characters, but every episode must include the heroine and at least one of the two male leads, and the main plot must remain about this trio.

CRITICAL BOUNDARY RULE (never violate):
- The prompt may include STORY STATE sections wrapped in markers such as [[STORY_STATE_BEGIN]] ... [[STORY_STATE_END]].
- These markers and their contents are private continuity scaffolding. NEVER reproduce marker text, instruction text, transition notes, or any meta-commentary in output.
- Output ONLY screenplay content (scene headings, action, dialogue). No instructions, no notes, no boundary tokens.

If the logline explicitly gives character names, you may align the provided HEROINE/MALE1/MALE2 tags with those names, but once the names are fixed you MUST keep them consistent in every episode.

You must write ONE EPISODE of a short-form / vertical drama script with these rules:
- The clear protagonist is the underdog heroine.
- Most negative events, misunderstandings, and external pressure fall on HER shoulders; the audience experiences the story primarily through her emotions and choices.
- There is at least one handsome, powerful man who is drawn to her; very often there are TWO male leads whose rivalry or tension revolves around her.
- The long-term arc is that she will eventually marry into money/power (e.g., a rich or high-status man), but do NOT resolve this too quickly—keep the romantic stakes and uncertainty alive across episodes.
- Keep the heroine active and resilient: she faces humiliation, setbacks, and schemes, but gradually gains confidence, agency, and leverage.
- Use screenplay-style scene headings like "INT. LOCATION - DAY" or "EXT. LOCATION - NIGHT".
- Mix vivid action lines and natural dialogue (CHARACTER NAME in caps, then their lines).
- Keep the episode focused, with 2–5 short scenes.
- SETTING AND VARIETY (critical): If a THIS EPISODE'S PLAN is provided in the prompt, you MUST open in the setting_focus location listed there — do not substitute a different or more familiar location. Every episode in a 60-episode series must feel like it inhabits a distinct part of the world. Do not default to the same dock, beach, or lobby opening simply because it is comfortable. The season outline pre-planned a specific setting and conflict type for each episode — treat both as hard constraints, not suggestions.
- Every episode should have a HOOK at the beginning. For early and middle episodes (when [EPISODE] is not within the last 5 of [EPISODES]), also end on a clear hook for the next episode—but keep them emotionally driven and grounded. Opening hooks should feel like a sharp emotional moment: an awkward intimacy beat, the heroine being subtly bullied or underestimated, a charged first encounter, or a small but vivid humiliation that makes us care. Closing hooks in these episodes should be light but addictive: a promise, a tease, a jealousy beat, a sudden confession or near-confession, or the hint of danger/competition around love or status.
- Avoid graphic violence, gore, or long slapstick brawls. Do NOT ramble or list random objects, professions, or technical details; stay tightly focused on the characters, their feelings, and the immediate scene.
- SPECIAL RULE FOR LATE EPISODES (when [EPISODE] is within the last 5 of [EPISODES]): progressively reduce unresolved threats and begin resolving major plot lines instead of opening new ones. Any end-of-episode hook in these late episodes should feel like the last steps toward closure (emotional decisions, consequences, or final preparations), not a brand-new danger, mystery, or villain.
- FINAL EPISODE RULE (when [EPISODE] == [EPISODES]): you MUST treat this as a true finale. Fully resolve the main external threat and the core emotional arc. End the script on safety, acceptance, or a clearly chosen future for the heroine and her relationships. Do NOT add any new threat, twist, or unseen observer in the last scene, and do NOT tease another season—no "it’s not over", "someone watches from the shadows", or similar cliffhangers.

CONFLICT AND ESCALATION REQUIREMENTS:
- Every episode must move at least ONE external stake forward in a concrete way (family approval/disapproval, money or contracts, company/pack politics, social reputation/public humiliation, or a rival’s scheme).
- Do NOT repeat the same "chase → corner → forced kiss" choreography in adjacent episodes. If a recent episode already used a strong physical-ownership beat, switch to a different form of conflict (verbal confrontation, public scene, business/family move, secret revealed, heroine gaining leverage).
- Physical closeness scenes (kisses, pinning, grabs) must either be clearly interrupted or have visible consequences, OR clearly increase the heroine’s agency (she sets a boundary, wins leverage, or initiates on her own terms).

ANTI-REPETITION AND FORMAT (critical — vertical scripts are sparse):
- Dialogue must dominate: each scene should be mostly character lines, not long prose.
- Action/stage direction: maximum 1–2 sentences per block. Never write long descriptive paragraphs; break into short beats (e.g. "She turns. He steps closer.").
- No adjective stacking: do NOT chain synonyms (e.g. incredible, extraordinary, miraculous, divine, magnificent). Use one strong word, then move on. Never repeat the same type of descriptor in a row.
- No lists of similar words or emotional synonyms. If you need intensity, use a single clear word and then action or dialogue.
- Do NOT output “synonym vomit” or word-list runs (e.g. many punctuation-free single-word adjectives across many lines). If you reach that point, rewrite the beat as normal screenplay action/dialogue.
- Each beat should be action or dialogue, not a run of descriptive adjectives.
- When you invent new powerful male characters (CEOs, bosses, shadowy masterminds), vary their names; do NOT repeatedly default to "Victor", "Lance", or "Ethan" across unrelated series. Prefer fresh, distinctive names that fit the setting and avoid name recycling.
 - Do NOT use the name "Victor" for ANY character unless it is explicitly provided in the [HEROINE=...] / [MALE1=...] / [MALE2=...] tags or in the user-provided logline. If you need a new name, pick something else.
 - When you invent new powerful male characters (CEOs, bosses, shadowy masterminds), vary their names; do NOT repeatedly default to "Lance" or "Ethan" across unrelated series. Prefer fresh, distinctive names that fit the setting and avoid name recycling.

WORD SPACING (critical — invalid output if broken):
- Put a normal ASCII space between every English word. Never merge tokens (e.g. "enteringthe", "histhere's", "nearbythe", "Lucasthis", "closeragainabout" are forbidden).
- After . ! ? and before the next sentence, include a space. After , ; : before the next word if needed, include a space.
- Hyphenated compounds are fine ("self-consciously"); random merges like "herselfconsciously" are not — use two words or a correct hyphenated form.

STRUCTURED BEATS (avoid dense run-ons):
- Prefer one short action thought per line or per sentence — not a single line that chains many clauses with commas (that pattern causes missing spaces and merged words).
- After each distinct beat ("Leo hands her a glass." / "Their fingers brush.") use a newline before the next beat when the line is getting long or dense.

SCREENPLAY LINE BREAKS (mandatory — parsers and PDF layout depend on this):
- Put each scene heading (e.g. INT. ROOM - NIGHT) on its own line, followed by a blank line, then the first action or dialogue.
- Character cue: the speaking character’s name in ALL CAPS alone on one line. The next line is their spoken dialogue (or a parenthetical on its own line between name and dialogue).
- NEVER glue a character name to dialogue or to a parenthetical on the same line. Forbidden examples: LUKESorry… / LUKE(mocking)You… / COLEUrgently… — always split onto separate lines.
- After each action paragraph or each line of dialogue, use a newline before the next element. Do not run multiple speakers or multiple action beats into one paragraph without line breaks.
- Transitions (FADE OUT., CUT TO:, etc.) go on their own line with a blank line before and after when they separate major beats.

STRUCTURE (critical — avoids broken exports):
- Do NOT output lines like "EPISODE 7" or "END OF EPISODE". The pipeline already knows the episode index and adds headings when saving. Start with your cold open or the first INT./EXT. scene heading.
- Write exactly ONE episode per response: never stack multiple "EPISODE N" sections or sneak in the next episode’s beats after an "END OF EPISODE" marker.

Output only script text for that episode. Do NOT output JSON, arrays, or any extra commentary.`;

const EPISODE_PLAN_SYSTEM_PROMPT = `You are a TV episode planner.
Return STRICT JSON only with this exact shape:
{
  "episodeNumber": number,
  "title": string,
  "scenePlan": [
    {
      "sceneIndex": number,
      "sceneHeading": string,
      "purpose": string,
      "mustIncludeCharacters": string[],
      "beats": string[]
    }
  ],
  "closingHook": string
}

Rules:
- 2 to 5 scenes only.
- Keep continuity with provided context.
- Keep the same three protagonist names exactly as provided.
- No markdown, no prose outside JSON.`;

const EPISODE_RENDER_FROM_PLAN_SYSTEM_PROMPT = `You are a screenplay writer.
You will receive:
1) episode context
2) a strict scene plan JSON

Write screenplay text for ONE episode only.
Rules:
- Follow the provided scene plan in order.
- Keep scene headings, action, and dialogue clear.
- Character cues must be on their own lines in ALL CAPS.
- Hard anti-merge contract:
  - Never glue words (e.g. togetherjust, Ruicollapses, beforeturningquicklytowardsthe).
  - Never glue cue/dialogue (e.g. LUKESorry).
- Action-line constraint:
  - Maximum 16 words per action line.
  - Break dense action into multiple short lines.
- Formatting contract:
  - Add a blank line after each scene heading.
  - Add a newline between distinct action beats.
- Keep continuity with prior context.
- Output script text only (no JSON, no notes).`;

function parseEpisodePlanJson(raw, episodeNumber) {
  const text = safeStr(raw).trim();
  if (!text) return null;
  const jsonMatch = text.match(/\{[\s\S]*\}$/);
  const payload = jsonMatch ? jsonMatch[0] : text;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.scenePlan) || parsed.scenePlan.length < 2) return null;
    parsed.episodeNumber = Number(parsed.episodeNumber) || episodeNumber;
    return parsed;
  } catch (_) {
    return null;
  }
}

async function generateEpisodeTextTwoPass({
  userContent,
  episodeNumber,
  totalEpisodes,
  names,
  language,
  genre,
}) {
  const planCompletion = await openai.chat.completions.create({
    model: PLANNER_MODEL,
    messages: [
      { role: "system", content: EPISODE_PLAN_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 1400,
    temperature: 0.35,
  });
  const planRaw = planCompletion.choices?.[0]?.message?.content;
  const plan = parseEpisodePlanJson(planRaw, episodeNumber);
  if (!plan) {
    return { ok: false, reason: "plan_parse_failed", text: "" };
  }

  const renderPrompt =
    `[LANG=${String(language || "EN").toUpperCase()}] [GENRE=${safeStr(genre) || "Romance"}] ` +
    `[EPISODES=${totalEpisodes}] [EPISODE=${episodeNumber}]\n` +
    `[HEROINE=${safeStr(names?.heroine)}] [MALE1=${safeStr(names?.coldCeo)}] [MALE2=${safeStr(
      names?.warmFriend
    )}]\n\n` +
    `CONTEXT:\n${userContent}\n\n` +
    `SCENE PLAN JSON:\n${JSON.stringify(plan, null, 2)}`;

  const renderCompletion = await openai.chat.completions.create({
    model: FINETUNED_MODEL,
    messages: [
      { role: "system", content: EPISODE_RENDER_FROM_PLAN_SYSTEM_PROMPT },
      { role: "user", content: renderPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.45,
    frequency_penalty: 1.0,
    presence_penalty: 0.5,
  });
  const rendered = renderCompletion.choices?.[0]?.message?.content;
  return {
    ok: typeof rendered === "string" && rendered.trim().length > 0,
    reason: "ok",
    text: typeof rendered === "string" ? rendered.trim() : "",
    plan,
  };
}

const NAME_CONSISTENCY_VALIDATION_SYSTEM_PROMPT = `You are a script formatting auditor.

Your task: given an episode's character cue lines, check whether the main trio character names are spelled consistently with the provided canonical spellings.

Important:
- Only inspect character cue headers (ALL CAPS speaker cue lines), including optional parentheticals like "(V.O.)", "(O.S.)", "(CONT'D)", "(WEAKLY)".
- Do NOT rewrite or modify the script.
- Identify likely misspellings/variants (case differences and letter transpositions) for the main trio only.

Output STRICT JSON with this shape:
{
  "ok": boolean,
  "mismatches": [
    {
      "expectedCanonicalKey": string,
      "expectedHeader": string,
      "foundVariant": string,
      "locationHint": string
    }
  ],
  "notes": string
}`;

function formatBlueprintContext(blueprint, episodeNumber) {
  if (!blueprint || !Array.isArray(blueprint.episodes)) return "";
  const total = blueprint.episodes.length;
  const ep = Math.max(1, Math.min(episodeNumber, total));
  const lines = [];

  // ── FULL SEASON VARIETY MAP ────────────────────────────────────────────────
  // Show the planned setting + conflict type for EVERY episode so the model
  // can see the full diversity that was designed and never deviate from it.
  // Format is compact: one short line per episode (~10-15 tokens total per line).
  lines.push("FULL SEASON PLAN — setting and conflict type for every episode (MANDATORY — never substitute a different location or conflict type):");
  for (let i = 0; i < blueprint.episodes.length; i++) {
    const p = blueprint.episodes[i];
    if (!p) continue;
    const epNum = p.episode ?? i + 1;
    const setting = p.setting_focus || "—";
    const conflict = p.conflict_type || "—";
    const emotional = p.emotional_focus || "";
    const marker = epNum === ep ? " ◄ THIS EPISODE" : (epNum < ep ? " ✓ done" : "");
    lines.push(`  Ep ${epNum}: setting=${setting} | conflict=${conflict}${emotional ? ` | emotion=${emotional}` : ""}${marker}`);
  }
  lines.push("");

  // ── CHARACTER ROLE CONSTRAINTS ─────────────────────────────────────────────
  if (Array.isArray(blueprint.characters) && blueprint.characters.length) {
    lines.push("CHARACTER ROLE CONSTRAINTS (do NOT break these):");
    for (const c of blueprint.characters) {
      if (!c || typeof c.name !== "string") continue;
      const name = c.name.trim();
      if (!name) continue;
      const role = typeof c.role === "string" ? c.role : "";
      const goal = typeof c.goal === "string" ? c.goal : "";
      const traits = Array.isArray(c.traits) ? c.traits.join(", ") : "";
      const taboos = Array.isArray(c.taboos) ? c.taboos.join(", ") : "";
      const parts = [`- ${name}`];
      if (role) parts.push(`role: ${role}`);
      if (goal) parts.push(`goal: ${goal}`);
      if (traits) parts.push(`traits: ${traits}`);
      if (taboos) parts.push(`taboos: ${taboos}`);
      lines.push(parts.join(" | "));
    }
    lines.push("");
  }

  // ── PREVIOUS EPISODES SUMMARY (all past, not just last 8) ─────────────────
  if (ep > 1) {
    lines.push("PREVIOUS EPISODES — planned arc (already happened; continue from here):");
    for (let i = 0; i < ep - 1; i++) {
      const plan = blueprint.episodes[i];
      if (plan && (plan.title || plan.main_conflict)) {
        const epNum = plan.episode ?? i + 1;
        const title = plan.title || `Episode ${epNum}`;
        const conflict = plan.main_conflict || plan.cliffhanger || "";
        const setting = plan.setting_focus ? ` [${plan.setting_focus}]` : "";
        lines.push(`  Ep ${epNum}${setting}: ${title}. ${conflict}`);
      }
    }
    lines.push("");
  }

  // ── CURRENT EPISODE PLAN ───────────────────────────────────────────────────
  const plan = blueprint.episodes[ep - 1];
  if (plan && typeof plan === "object") {
    lines.push("THIS EPISODE'S PLAN (follow this beat for beat — every field below is a hard constraint, not a suggestion):");
    lines.push(`  Title: ${plan.title || `Episode ${ep}`}`);
    // setting_focus and emotional_focus were missing before — now explicitly enforced
    if (plan.setting_focus) lines.push(`  Setting (REQUIRED — episode must be set here): ${plan.setting_focus}`);
    if (plan.emotional_focus) lines.push(`  Emotional focus (REQUIRED — dominant emotional tone): ${plan.emotional_focus}`);
    if (plan.heroine_state) lines.push(`  Heroine state: ${plan.heroine_state}`);
    if (plan.male1_state)   lines.push(`  Male lead 1 state: ${plan.male1_state}`);
    if (plan.male2_state)   lines.push(`  Male lead 2 state: ${plan.male2_state}`);
    if (plan.main_conflict) lines.push(`  Main conflict: ${plan.main_conflict}`);
    if (plan.hook_type)     lines.push(`  Hook type: ${plan.hook_type}`);
    if (plan.conflict_type) lines.push(`  Conflict type: ${plan.conflict_type}`);
    if (plan.key_events && plan.key_events.length)
      lines.push(`  Key events: ${plan.key_events.join("; ")}`);
    if (plan.twist_or_reveal) lines.push(`  Twist/reveal: ${plan.twist_or_reveal}`);
    if (plan.cliffhanger)     lines.push(`  End on cliffhanger: ${plan.cliffhanger}`);
    if (Array.isArray(plan.micro_beats) && plan.micro_beats.length === 4) {
      lines.push("  MICRO-STRUCTURE (follow this order exactly — these are the four required beats):");
      lines.push(`    1) HOOK: ${plan.micro_beats[0]}`);
      lines.push(`    2) CONFLICT: ${plan.micro_beats[1]}`);
      lines.push(`    3) MINI-TWIST: ${plan.micro_beats[2]}`);
      lines.push(`    4) CLIFFHANGER: ${plan.micro_beats[3]}`);
    }
  }

  return lines.length ? lines.join("\n") : "";
}

// How many prior episodes to include in full for continuation (token budget).
const PREVIOUS_EPISODES_IN_CONTEXT = 1;

/** Minimal user prompt for collapse rescue — avoids resending the full context that triggered the failure. */
function buildCollapseRescueUserPrompt({
  language,
  genre,
  totalEpisodes,
  episodeNumber,
  logline,
  names,
  blueprint,
}) {
  const langTag = String(language || "EN").toUpperCase() === "ZH" ? "ZH" : "EN";
  const genreTag = String(genre || "Romance").trim() || "Romance";
  const total = Math.max(1, totalEpisodes || 1);
  const ep = Math.max(1, episodeNumber || 1);
  const blueprintContext = formatBlueprintContext(blueprint, ep);
  const parts = [
    `[LANG=${langTag}] [GENRE=${genreTag}] [EPISODES=${total}] [EPISODE=${ep}]`,
  ];
  if (names?.heroine && names?.coldCeo && names?.warmFriend) {
    parts.push(
      `[HEROINE=${names.heroine}] [MALE1=${names.coldCeo}] [MALE2=${names.warmFriend}]`
    );
  }
  parts.push(`[LOGLINE] ${safeStr(logline).slice(0, 500)}`);
  parts.push(
    "Write ONE complete episode of screenplay for the episode number above. Use the cast and logline only. Named characters only. Concrete action and dialogue. No abstract prose, no philosophy monologues, no vocabulary lists. Use standard screenplay format: scene headings (INT./EXT.), character cues in ALL CAPS, dialogue on the following line."
  );
  if (blueprintContext) {
    parts.push(
      `THIS EPISODE PLAN (follow beats; stay concrete):\n${blueprintContext.slice(0, 600)}`
    );
  }
  return parts.join("\n\n");
}

function buildEpisodePromptText({
  language,
  genre,
  totalEpisodes,
  episodeNumber,
  logline,
  names,
  genreBible,
  blueprint,
  episodeSummaries,
  recaps,
  previousEpisodeStates = [],
  previousEpisodeScripts = [],
  narrativeResetText = "",
  trimContext = ENABLE_TRIMMED_CONTEXT,
}) {
  const langTag = String(language || "EN").toUpperCase() === "ZH" ? "ZH" : "EN";
  const genreTag = String(genre || "Romance").trim() || "Romance";
  const total = Math.max(1, totalEpisodes || 1);
  const ep = Math.max(1, episodeNumber || 1);
  const cleanLogline = safeStr(logline).slice(0, 1500);

  const lines = [
    `[LANG=${langTag}] [GENRE=${genreTag}] [EPISODES=${total}] [EPISODE=${ep}]`,
  ];
  if (names && names.heroine && names.coldCeo && names.warmFriend) {
    lines.push(
      `[HEROINE=${names.heroine}] [MALE1=${names.coldCeo}] [MALE2=${names.warmFriend}]`
    );
    lines.push(
      `In this series, the heroine is ${names.heroine} (female underdog), ` +
        `the cold powerful male lead is ${names.coldCeo}, and the warm supportive male lead is ${names.warmFriend}. ` +
        `Use THESE exact names consistently in every episode unless the logline explicitly overrides them.`
    );
    // Phase 3: upstream prompt reinforcement — locked manifest for cue headers + prose mentions.
    lines.push("");
    lines.push("CHARACTER MANIFEST (locked canonical spellings; do NOT vary):");
    lines.push(
      `- HEROINE HEADER: ${String(names.heroine).toUpperCase()} | PROSE: ${titleCaseName(
        names.heroine
      )} | POSSESSIVE: ${String(names.heroine).toUpperCase()}'S`
    );
    lines.push(
      `- MALE1 HEADER: ${String(names.coldCeo).toUpperCase()} | PROSE: ${titleCaseName(
        names.coldCeo
      )} | POSSESSIVE: ${String(names.coldCeo).toUpperCase()}'S`
    );
    lines.push(
      `- MALE2 HEADER: ${String(names.warmFriend).toUpperCase()} | PROSE: ${titleCaseName(
        names.warmFriend
      )} | POSSESSIVE: ${String(names.warmFriend).toUpperCase()}'S`
    );
    lines.push(
      "RULE: Any ALL CAPS dialogue cue/header for these characters MUST match the HEADER spellings exactly. Any prose/action mentions MUST use the PROSE spellings exactly."
    );
    if (names.corporationName) {
      lines.push(
        `For finance/boardroom storylines use this corporation consistently: ${names.corporationName}.`
      );
    }
    // Pre-generated supporting cast pool — prevents the model defaulting to recycled names
    if (names.supportingNames) {
      const m = Array.isArray(names.supportingNames.male)   ? names.supportingNames.male.join(", ")   : "";
      const f = Array.isArray(names.supportingNames.female) ? names.supportingNames.female.join(", ") : "";
      if (m || f) {
        lines.push("");
        lines.push("SUPPORTING CHARACTER NAME POOL (use these for any new characters introduced in this episode):");
        if (m) lines.push(`  Male supporting names: ${m}`);
        if (f) lines.push(`  Female supporting names: ${f}`);
        lines.push("  Do NOT default to Victor, Ethan, Lance, or other overused names. Draw from the pool above.");
      }
    }
    if (!blueprint) {
      const fb = formatFallbackCharacterConstraints(names);
      if (fb) {
        lines.push("");
        lines.push(fb);
      }
    }
  }
  if (cleanLogline) {
    lines.push(`[LOGLINE] ${cleanLogline}`);
  }

  if (genreBible && typeof genreBible === "object") {
    const threat = safeStr(genreBible.threat);
    const stakes = safeStr(genreBible.stakes);
    const hub = safeStr(genreBible.setting_hub);
    const obstacle = safeStr(genreBible.central_obstacle);
    const rules = Array.isArray(genreBible.rules)
      ? genreBible.rules.map((r) => safeStr(r)).filter(Boolean).slice(0, 4)
      : [];
    if (threat || stakes || hub || rules.length) {
      lines.push("");
      lines.push("GENRE BIBLE (must remain true across all episodes):");
      if (hub) lines.push(`- Setting hub (do not drift): ${hub}`);
      if (obstacle) lines.push(`- Central obstacle: ${obstacle}`);
      if (threat) lines.push(`- Core threat: ${threat}`);
      if (stakes) lines.push(`- Stakes: ${stakes}`);
      if (rules.length) {
        lines.push(`- Rules: ${rules.join(" | ")}`);
      }
      lines.push(
        "- Continuity lock: do NOT replace the protagonists. Do NOT introduce a new storyline that doesn't include the heroine and BOTH male leads."
      );
      lines.push("");
    }
  }

  const blueprintContext = formatBlueprintContext(blueprint, ep);
  const seriesHistory = ep > 3 ? formatSeriesHistoryBlock(recaps, ep) : "";
  const recapContext = narrativeResetText
    ? `NARRATIVE RESET CHECKPOINT:\n${narrativeResetText}`
    : trimContext
    ? (() => {
        if (!Array.isArray(recaps) || !recaps.length) return "";
        const prev = recaps
          .filter((r) => typeof r.episode === "number" && r.episode < ep)
          .slice(ep < 20 ? -6 : ep < 40 ? -5 : -4); // expanded from -3/-2/-1
        if (!prev.length) return "";
        const maxChars = ep < 20 ? 220 : ep < 40 ? 160 : 120;
        const compact = prev.map((r) => `Ep ${r.episode}: ${safeStr(r.recap).slice(0, maxChars)}`);
        return ["COMPACT STORY STATE (recent recaps):", ...compact].join("\n");
      })()
    : formatRecapContext(recaps, ep);
  const summaryText =
    episodeSummaries && episodeSummaries instanceof Map
      ? episodeSummaries.get(ep)
      : null;
  const recentEvents = formatRecentEventConstraints(recaps, ep);
  const openingHistory = ep > 1 ? formatOpeningHistory(recaps, ep) : "";

  if (blueprintContext || seriesHistory || recapContext || summaryText || recentEvents || openingHistory) {
    lines.push("");
    if (blueprintContext) lines.push(blueprintContext);
    if (seriesHistory) {
      if (blueprintContext) lines.push("");
      lines.push(seriesHistory);
    }
    if (recapContext) {
      if (blueprintContext || seriesHistory) lines.push("");
      lines.push(recapContext);
    }
    if (recentEvents) {
      if (blueprintContext || seriesHistory || recapContext) lines.push("");
      lines.push(recentEvents);
    }
    if (openingHistory) {
      if (blueprintContext || seriesHistory || recapContext || recentEvents) lines.push("");
      lines.push(openingHistory);
    }
    if (summaryText) {
      if (blueprintContext || recapContext || recentEvents || openingHistory) lines.push("");
      lines.push("THIS EPISODE'S SUMMARY (follow this beat for beat; do not invent new major subplots):");
      lines.push(summaryText);
    }
    lines.push("");
  }

  // Continuity: inject the raw tail of the previous episode(s) so the model continues
  // from the EXACT last moment on screen — not from an abstract summary.
  // Raw tail text is the primary driver of scene variety: the model cannot reset to a
  // familiar location because it is anchored to wherever the previous episode ended.
  // Abstract state (location/ending/character_state) is kept as a supplementary note only.
  if (ep > 1 && Array.isArray(previousEpisodeScripts) && previousEpisodeScripts.length > 0) {
    const TAIL_LINES = 30;
    const toInclude = previousEpisodeScripts.slice(-PREVIOUS_EPISODES_IN_CONTEXT);
    const label = toInclude.length === 1 ? "PREVIOUS EPISODE" : "PREVIOUS EPISODES";
    lines.push("");
    lines.push(
      `CONTINUATION REQUIREMENT (critical for this format): The audience has just paid to see what happens next. ` +
      `Below is the exact end of the ${label}. You MUST continue the story immediately from the next moment — ` +
      `same scene, same characters, same emotional beat. Do not time-skip, change location, or restart; ` +
      `pick up from the last line or action and continue.`
    );
    lines.push(
      `DO NOT restage the same key moments from the previous episode. ` +
      `If you need to reference them, compress into one short recap line, then move FORWARD with new events.`
    );
    lines.push("");
    toInclude.forEach((script, i) => {
      const which = toInclude.length === 1 ? "PREVIOUS EPISODE" : `EPISODE ${ep - toInclude.length + i}`;
      const full = safeStr(script).trim();
      const tail = full.split(/\r?\n/).slice(-TAIL_LINES).join("\n");
      lines.push(`--- END OF ${which} ---`);
      lines.push(tail);
      lines.push(`--- END OF ${which} ---`);
      lines.push("");
    });
    lines.push(`Write episode ${ep} now, continuing directly from the text above.`);
    lines.push("");
  } else if (ep > 1 && Array.isArray(previousEpisodeStates) && previousEpisodeStates.length > 0) {
    // Fallback: no raw scripts available, use abstract state only
    const toInclude = previousEpisodeStates.slice(-PREVIOUS_EPISODES_IN_CONTEXT);
    lines.push("");
    lines.push(`CONTINUATION REQUIREMENT: Continue immediately from previous episode state with no timeline reset.`);
    lines.push("");
    toInclude.forEach((state, i) => {
      const which = toInclude.length === 1 ? "PREVIOUS EPISODE" : `EPISODE ${ep - toInclude.length + i}`;
      lines.push(`${which}: location=${safeStr(state.location)} | ending=${safeStr(state.ending)} | character_state=${safeStr(state.character_state)}`);
    });
    lines.push("");
  }

  if (trimContext) {
    lines.push("CONTEXT BUDGET MODE: compact continuity context is enabled.");
  }

  let phase;
  if (ep <= Math.max(3, Math.floor(total * 0.1))) {
    phase = "beginning (set-up: humiliation and underdog struggles)";
  } else if (ep <= Math.max(15, Math.floor(total * 0.5))) {
    phase = "middle (escalating love triangle, secrets, and power imbalance)";
  } else if (ep <= Math.max(25, Math.floor(total * 0.8))) {
    phase = "late middle (big reversals, heroine gains leverage, villains exposed)";
  } else {
    phase = "finale arc (resolving major conflicts, moving toward marriage/powerful ending)";
  }

  const isFinalEpisode = ep === total;
  const isLandingZone = ep >= Math.max(1, total - 4); // last 5 episodes

  // If we're in the finale arc, steer toward a genre-appropriate planned ending.
  let plannedEnding = "";
  if (phase.startsWith("finale")) {
    const endingsData = loadEndingsByGenre();
    const endingsList = Array.isArray(endingsData[genreTag]) ? endingsData[genreTag] : [];
    if (endingsList.length > 0) {
      plannedEnding = endingsList[Math.floor(Math.random() * endingsList.length)];
    }
  }

  if (plannedEnding) {
    lines.push("");
    lines.push(
      `PLANNED ENDING FOR THE SEASON (guidance): The overall story should ultimately resolve like this: ${plannedEnding}`
    );
    if (isFinalEpisode) {
      lines.push(
        `Because this is the FINAL episode, you MUST fully resolve the main conflicts and land on this kind of emotional resolution. ` +
          `Do NOT cut the story off in the middle of major consequences—after the main climax include at least one clear aftermath or epilogue beat that matches this ending tone.`
      );
    } else if (isLandingZone) {
      lines.push(
        `Because we are now in the last few episodes of the finale arc, this episode must actively steer the plot and emotions toward this resolution. ` +
          `Begin closing open threads and avoid introducing brand-new major threats; any hook at the end should feel like the last breaths before resolution, not a fresh storyline.`
      );
    } else {
      lines.push(
        `Because we are now in the finale arc, this episode should meaningfully push the story toward that resolution—even if it still ends on a hook.`
      );
    }
  }

  if (ep <= 10) {
    lines.push(
      "HOOK REQUIREMENT (early episodes): Start with a small but sharp emotional moment (awkward intimacy, subtle bullying, jealousy, or a vivid humiliation) and end with a light but addictive hook (a tease, promise, jealousy beat, or near-confession). No graphic violence, no gore, no long slapstick fights; stay close to the characters’ feelings."
    );
  }

  if (isFinalEpisode) {
    // Final episode: land the story instead of adding a new cliffhanger.
    lines.push(
      `This is episode ${ep} of ${total}, the FINAL episode of this continuous story about the same heroine and the same two male leads. ` +
        `Previous episodes are already written; do NOT restart the story, change character names, or reset their relationships. ` +
        (blueprintContext
          ? `Follow the season outline and THIS EPISODE'S PLAN above. `
          : "") +
        (ep > 1 && previousEpisodeStates.length > 0
          ? `You have been given the exact previous episode text above—continue from its last line. `
          : "") +
        `Treat this as the finale and bring the main plot lines and central relationships to a clear resolution. ` +
        `If a PLANNED ENDING is given above, you MUST shape the climax and the aftermath so the emotional tone and outcome match that planned ending. ` +
        `Do NOT end on a brand-new cliffhanger; instead, after the main climax include at least one short aftermath or epilogue beat showing how the heroine and the leads live with the consequences. ` +
        `In the FINAL SCENE and FINAL PARAGRAPHS you must NOT introduce any new villains, bosses, institutions, or mysterious figures (no surprise CEOs, no new organisations, no unknown watchers); only already-known characters may appear. ` +
        `The last 3–5 paragraphs must LOWER the immediate danger level and show safety, acceptance, or a clearly chosen future for the heroine. The final line should read as a satisfying series ending, not as a question or teaser. ` +
        `Keep prose sparse: short action beats, dialogue-led scenes, no adjective stacking or synonym chains.`
    );
  } else {
    // Non-final episodes
    if (isLandingZone) {
      // Landing zone: start closing threads, softer hooks.
      lines.push(
        `This is episode ${ep} of ${total} of ONE continuous story about the same heroine and the same two male leads. ` +
          `Previous episodes are already written; do NOT restart the story, change character names, or reset their relationships. ` +
          (blueprintContext
            ? `Follow the season outline and THIS EPISODE'S PLAN above. `
            : "") +
          (ep > 1 && previousEpisodeStates.length > 0
            ? `You have been given the exact previous episode text above—continue from its last line. `
            : "") +
          `Treat this as part of the finale arc, and begin RESOLVING major plot lines and emotional arcs rather than opening new ones. ` +
          `Do NOT introduce brand-new central villains, conspiracies, or powerful organisations in these late episodes; focus on paying off what already exists. ` +
          `Any end-of-episode hook in this landing zone should feel like the last steps toward closure (final confrontations, decisions, or consequences), not like the start of a new storyline. Each of these endings must feel more stable and closer to resolution than the previous episode. ` +
          `Keep prose sparse: short action beats, dialogue-led scenes, no adjective stacking or synonym chains.`
      );
    } else {
      // Regular episodes: strong hooks.
      lines.push(
        `This is episode ${ep} of ${total} of ONE continuous story about the same heroine and the same two male leads. ` +
          `Previous episodes are already written; do NOT restart the story, change character names, or reset their relationships. ` +
          (blueprintContext
            ? `Follow the season outline and THIS EPISODE'S PLAN above. `
            : "") +
          (ep > 1 && previousEpisodeStates.length > 0
            ? `You have been given the exact previous episode text above—continue from its last line. `
            : "") +
          `Treat this as the ${phase}, and continue the same plot line. ` +
          `Maintain consistency with earlier implied events and keep the tone and premise aligned with the logline. ` +
          `End on a strong cliffhanger or unresolved emotional beat for the heroine. ` +
          `Keep prose sparse: short action beats, dialogue-led scenes, no adjective stacking or synonym chains.`
      );
    }
  }
  lines.push(
    "Output formatting: blank line after each scene heading; each character cue (ALL CAPS name) on its own line with dialogue on the following line — never output glued cues like LUKESorry or LUKE(mocking)You."
  );
  return lines.join("\n");
}

function sendStreamLine(res, obj) {
  res.write(JSON.stringify(obj) + "\n");
}

function buildCollapseSafeEpisodeFallbackSync({
  episodeNumber,
  totalEpisodes,
  names,
  genre,
  summary,
  plan,
}) {
  const heroine = safeStr(names?.heroine) || "THE HEROINE";
  const male1 = safeStr(names?.coldCeo) || "MALE LEAD 1";
  const male2 = safeStr(names?.warmFriend) || "MALE LEAD 2";
  const heroineUpper = heroine.toUpperCase();
  const male1Upper = male1.toUpperCase();
  const male2Upper = male2.toUpperCase();
  const isFinal = episodeNumber === totalEpisodes;

  const isWerewolf = /horror|monster|werewolf/i.test(String(genre || ""));
  const isAction = /action|crime|superhero/i.test(String(genre || ""));

  // Pull concrete details from blueprint plan if available
  const conflict = safeStr(plan?.main_conflict).trim();
  const cliffhanger = safeStr(plan?.cliffhanger).trim();
  const keyEvents = Array.isArray(plan?.key_events) ? plan.key_events.filter(Boolean) : [];

  // Pick locations appropriate to genre
  const loc1 = isWerewolf ? "INT. PACK HOUSE - DAY" : isAction ? "INT. PRECINCT - DAY" : "INT. OFFICE LOBBY - DAY";
  const loc2 = isWerewolf ? "EXT. FOREST CLEARING - NIGHT" : isAction ? "EXT. CITY STREET - NIGHT" : "INT. PRIVATE OFFICE - NIGHT";

  // Build a plausible conflict line from plan data or fallback
  const conflictLine = conflict
    ? conflict
    : `The tension between ${heroine} and ${male1} reaches a breaking point.`;

  // Build a scene-1 beat using the first key event if present
  const beat1 = keyEvents[0]
    ? `${keyEvents[0]}`
    : `${heroine} faces an unexpected confrontation she cannot ignore.`;

  // Scene 2 beat
  const beat2 = keyEvents[1]
    ? `${keyEvents[1]}`
    : `${male1} makes a decision that changes everything.`;

  // Closing line
  const closingLine = isFinal
    ? `${heroine} finally takes back control of her own story.`
    : cliffhanger
    ? cliffhanger
    : `${heroine} knows the next move will define who she really is.`;

  return [
    loc1,
    "",
    `${conflictLine}`,
    "",
    heroineUpper,
    "I'm not running from this. Not anymore.",
    "",
    male1Upper,
    "Then stand your ground. I'll be right here.",
    "",
    `${beat1}`,
    "",
    loc2,
    "",
    `${beat2}`,
    "",
    male2Upper,
    "Whatever happens next — I'm with you.",
    "",
    heroineUpper,
    "Then let's finish this.",
    "",
    `${closingLine}`,
  ].join("\n");
}

async function buildCollapseSafeEpisodeFallback(params) {
  const { episodeNumber, totalEpisodes, names, genre, summary, plan } = params;
  const heroine = safeStr(names?.heroine) || "the heroine";
  const male1   = safeStr(names?.coldCeo) || "the male lead";
  const male2   = safeStr(names?.warmFriend) || "the second lead";
  const setting  = safeStr(plan?.setting_focus) || "an interior location";
  const conflict = safeStr(plan?.main_conflict) || "a personal confrontation";
  const microBeats = Array.isArray(plan?.micro_beats) ? plan.micro_beats.filter(Boolean) : [];
  const keyEvents  = Array.isArray(plan?.key_events)  ? plan.key_events.filter(Boolean)  : [];
  const cliffhanger = safeStr(plan?.cliffhanger);
  const isFinal = episodeNumber === totalEpisodes;

  const beatLines = microBeats.length
    ? `Beats to hit:\n${microBeats.map((b) => `- ${b}`).join("\n")}`
    : keyEvents.length
    ? `Key events:\n${keyEvents.map((e) => `- ${e}`).join("\n")}`
    : "";

  const endingInstruction = isFinal
    ? "This is the series finale — resolve the main arc with emotional closure."
    : cliffhanger
    ? `End with this hook: ${cliffhanger}`
    : "End on an emotional hook that draws the viewer into the next episode.";

  const userPrompt = [
    `Write episode ${episodeNumber} of ${totalEpisodes} of a vertical drama series.`,
    `Genre: ${genre || "drama"}`,
    `Characters: ${heroine} (heroine), ${male1} (male lead 1), ${male2} (male lead 2)`,
    `Setting: ${setting}`,
    `Main conflict: ${conflict}`,
    beatLines,
    summary ? `Episode summary: ${summary}` : "",
    endingInstruction,
    "",
    "Write a SHORT but COMPLETE screenplay episode (2–3 scenes). Rules:",
    "- Use INT./EXT. scene headings (e.g. INT. LOCATION - DAY).",
    "- Character name in ALL CAPS alone on its own line, then dialogue on the next line.",
    "- Action/description: 1–2 short sentences per block.",
    "- Do NOT output episode numbers, metadata, or commentary — screenplay content only.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await openai.chat.completions.create({
      model: PLANNER_MODEL,
      max_tokens: 900,
      temperature: 0.72,
      messages: [
        {
          role: "system",
          content:
            "You are a vertical drama screenplay writer. Write compact, well-formatted screenplay scenes. Use proper INT./EXT. scene headings, ALL CAPS character cues on their own lines, natural dialogue, and keep action lines to 1–2 sentences. Output only screenplay content.",
        },
        { role: "user", content: userPrompt },
      ],
    });
    const generated = safeStr(resp.choices?.[0]?.message?.content).trim();
    if (generated.length > 200) return generated;
  } catch (llmErr) {
    console.error(`LLM fallback generation failed for episode ${episodeNumber}:`, llmErr?.message);
  }

  // Deterministic backstop when LLM call fails.
  return buildCollapseSafeEpisodeFallbackSync(params);
}

function targetedCollapseSpanRepair(text, names) {
  const lines = safeStr(text).split(/\r?\n/);
  if (!lines.length) return text;
  const anchors = buildNameAnchors(names);
  const repaired = [];
  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    if (run.length >= 6) {
      const heroine = safeStr(names?.heroine) || "THE HEROINE";
      const male1 = safeStr(names?.coldCeo) || "MALE LEAD 1";
      const male2 = safeStr(names?.warmFriend) || "MALE LEAD 2";
      repaired.push(`${heroine.toUpperCase()}`);
      repaired.push("Stay with me. We focus on what matters right now.");
      repaired.push("");
      repaired.push(`${male1.toUpperCase()}`);
      repaired.push("We move to the next concrete step. No distractions.");
      repaired.push("");
      repaired.push(`${male2.toUpperCase()}`);
      repaired.push("I'm here. We decide together and keep moving.");
    } else {
      repaired.push(...run);
    }
    run = [];
  };

  for (const raw of lines) {
    const line = safeStr(raw);
    if (!line) {
      flushRun();
      repaired.push("");
      continue;
    }
    const isScene = /^(INT\.|EXT\.|INT\/EXT\.|EXT\/INT\.)/i.test(line);
    const isCue = /^[A-Z][A-Z0-9 '\-]{1,30}$/.test(line) && !/^(EPISODE|END EPISODE|FADE|CUT)/i.test(line);
    const hasName = anchors.some((n) =>
      new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line)
    );
    const words = line.split(/\s+/).filter(Boolean);
    const looksUnanchored =
      !isScene &&
      !isCue &&
      !hasName &&
      (words.length >= 10 || (lineHasCollapseLexicon(line) && words.length >= 8));
    if (looksUnanchored) {
      run.push(line);
      continue;
    }
    flushRun();
    repaired.push(line);
  }
  flushRun();
  return repaired.join("\n");
}

function targetedRepairEpisodeText(text, names) {
  const mergeRes = fixMergedWordIssuesPhase2Detailed(text, {
    characterNames: [names?.heroine, names?.coldCeo, names?.warmFriend].filter(Boolean),
    dynamicPatterns: DYNAMIC_MERGE_PATTERNS,
  });
  const collapsed = targetedCollapseSpanRepair(mergeRes.text, names);
  return {
    text: collapsed,
    spanRepairsApplied: mergeRes.logs.reduce((acc, x) => acc + (x.count || 0), 0),
    repairTypes: mergeRes.logs.filter((x) => (x.count || 0) > 0).map((x) => x.rule),
  };
}

function includesWord(haystack, word) {
  const s = safeStr(haystack);
  if (!s) return false;
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
  return re.test(s);
}

function pickReplacementNameForVictor() {
  // Keep a small curated set to avoid odd/unfitting replacements.
  const pool = ["Damien", "Tristan", "Dominic", "Sebastian", "Marcus", "Adrian", "Vincent", "Malcolm"];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Auth (optional) - bcrypt + Postgres + JWT bearer
// Enable by setting:
// - AUTH_ENABLED=true
// - JWT_SECRET=... (required)
// - Postgres vars (DATABASE_URL or PGHOST+PGUSER+PGDATABASE(+PGPASSWORD))
// ---------------------------------------------------------------------------
app.post("/auth/register", (req, res) => registerUser(req, res));
app.post("/auth/login", (req, res) => loginUser(req, res));
app.post("/auth/confirm-email", (req, res) => verifyEmailCode(req, res));

app.post("/generate", requireAuth, async (req, res) => {
  const body = req.body || {};
  const episodeCount = Math.max(1, Math.min(120, parseInt(body.episodeCount, 10) || 60));
  let logline = safeStr(body.logline).slice(0, 1500);
  const genre = String(body.genre || "Romance").trim() || "Romance";
  const seriesNames = getSeriesNames(genre);
  const generationLangTag = String(body.language || "EN").toUpperCase();
  const shouldRunNameValidation = generationLangTag !== "ZH";
  const tropes = body.tropes && typeof body.tropes === "object" ? body.tropes : null;
  const shouldNormalizeLogline = body.normalizeLogline !== false;
  const wordCount = logline ? logline.trim().split(/\s+/).filter(Boolean).length : 0;
  const minWords = 25;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  try {
    if (!logline || wordCount < minWords) {
      res.status(400);
      sendStreamLine(res, {
        type: "error",
        message: `Summary must be at least ${minWords} words (currently ${wordCount}).`,
      });
      sendStreamLine(res, { type: "done" });
      return res.end();
    }

    let genreBible = null;
    if (shouldNormalizeLogline && logline) {
      try {
        genreBible = await normalizeGenreLogline({
          rawLogline: logline,
          genre,
          names: seriesNames,
        });
        if (genreBible && genreBible.logline) {
          logline = genreBible.logline;
          sendStreamLine(res, { type: "logline_normalized", ok: true });
        }
      } catch (e) {
        console.error("Logline normalization failed:", e);
        sendStreamLine(res, { type: "logline_normalized", ok: false });
      }
    }

    let blueprint = null;
    let episodeSummaries = null;
    const episodeRecaps = [];
    try {
      blueprint = await generateSeasonBlueprint({
        episodeCount,
        logline,
        genre,
        names: seriesNames,
        tropes,
      });
      sendStreamLine(res, {
        type: "blueprint",
        ok: true,
        episodes: Array.isArray(blueprint.episodes)
          ? blueprint.episodes.length
          : 0,
      });

      try {
        episodeSummaries = await generateEpisodeSummaries({
          blueprint,
          logline,
          genre,
        });
        if (episodeSummaries && episodeSummaries instanceof Map) {
          sendStreamLine(res, {
            type: "episode_summaries",
            ok: true,
            episodes: episodeSummaries.size,
          });
        }
      } catch (sumErr) {
        console.error("Episode summary generation failed:", sumErr);
        sendStreamLine(res, {
          type: "episode_summaries",
          ok: false,
          message: sumErr.message || "Failed to generate per-episode summaries",
        });
      }
    } catch (bpErr) {
      console.error("Blueprint generation failed:", bpErr);
      sendStreamLine(res, {
        type: "blueprint",
        ok: false,
        message: bpErr.message || "Failed to generate season blueprint",
      });
      // We continue without a blueprint; episodes will still be generated using only the logline.
    }

    const episodeScriptsMemo = [];
    const episodeStateMemo = [];
    const narrativeResetMemo = new Map();
    const victorAllowed =
      includesWord(logline, "Victor") ||
      includesWord(seriesNames?.heroine, "Victor") ||
      includesWord(seriesNames?.coldCeo, "Victor") ||
      includesWord(seriesNames?.warmFriend, "Victor");

    for (let ep = 1; ep <= episodeCount; ep++) {
      sendStreamLine(res, { type: "progress", episode: ep, total: episodeCount });

      try {
        let narrativeResetText = "";
        const narrativeResetEpisodes = /superhero|sci[-.\s]?fi|science\s*fiction|fantasy|horror|monster|werewolf/i.test(
          String(genre || "")
        )
          ? [10, 25, 45]
          : [20, 40];
        if (narrativeResetEpisodes.includes(ep) && !narrativeResetMemo.has(ep)) {
          try {
            const reset = await buildFullNarrativeReset(
              episodeRecaps,
              seriesNames,
              logline,
              ep
            );
            if (reset) {
              narrativeResetMemo.set(ep, reset);
              sendStreamLine(res, { type: "narrative_reset", episode: ep, ok: true });
            }
          } catch (resetErr) {
            console.error(`Narrative reset generation failed for episode ${ep}:`, resetErr);
            sendStreamLine(res, { type: "narrative_reset", episode: ep, ok: false });
          }
        }
        if (narrativeResetMemo.has(ep)) narrativeResetText = narrativeResetMemo.get(ep) || "";

        const userContent = buildEpisodePromptText({
          language: body.language || "EN",
          genre,
          totalEpisodes: episodeCount,
          episodeNumber: ep,
          logline,
          names: seriesNames,
          genreBible,
          blueprint,
          episodeSummaries,
          recaps: episodeRecaps,
          previousEpisodeStates: episodeStateMemo,
          previousEpisodeScripts: episodeScriptsMemo,
          narrativeResetText,
          trimContext: ENABLE_TRIMMED_CONTEXT,
        });
        sendStreamLine(res, {
          type: "prompt_metrics",
          episode: ep,
          chars: userContent.length,
          approx_tokens: estimatePromptTokens(userContent),
          trim_context: ENABLE_TRIMMED_CONTEXT,
          mode: ENABLE_TWO_PASS_EPISODE ? "two_pass" : "single_pass",
        });

        let rawContent = "";
        if (ENABLE_TWO_PASS_EPISODE) {
          try {
            const twoPass = await generateEpisodeTextTwoPass({
              userContent,
              episodeNumber: ep,
              totalEpisodes: episodeCount,
              names: seriesNames,
              language: body.language || "EN",
              genre,
            });
            if (twoPass.ok) {
              rawContent = twoPass.text;
              sendStreamLine(res, { type: "episode_mode", episode: ep, mode: "two_pass" });
            } else {
              sendStreamLine(res, {
                type: "episode_mode",
                episode: ep,
                mode: "single_pass_fallback",
                reason: twoPass.reason,
              });
            }
          } catch (twoPassErr) {
            console.error(`Two-pass generation failed for episode ${ep}:`, twoPassErr);
            sendStreamLine(res, {
              type: "episode_mode",
              episode: ep,
              mode: "single_pass_fallback",
              reason: "two_pass_error",
            });
          }
        }
        if (!rawContent) {
          const completion = await openai.chat.completions.create({
            model: FINETUNED_MODEL,
            messages: [
              { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
              { role: "user", content: userContent },
            ],
            max_tokens: 2048,
            temperature: 0.5,
            frequency_penalty: 1.0,
            presence_penalty: 0.6,
          });
          rawContent = completion.choices?.[0]?.message?.content || "";
        }

        let episodeText =
          typeof rawContent === "string" && rawContent.trim()
            ? rawContent.trim()
            : `[Episode ${ep} — no content]`;

        episodeText = finalizeEpisodeText(episodeText, ep, seriesNames);
        // Phase 3 validation — detect and FIX main-trio name inconsistencies before canonicalization.
        if (shouldRunNameValidation) {
          try {
            const mismatches = detectMainTrioNameMismatches(episodeText, seriesNames);
            if (mismatches.length > 0) {
              // Apply corrections immediately (was log-only before — bug fix)
              episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
              const report = await validateMainTrioNameConsistencyWithLLM({
                episodeText,
                names: seriesNames,
                episodeNumber: ep,
              });
              if (report && report.ok === false) {
                console.warn(
                  `Name consistency mismatches (episode ${ep}):`,
                  report.mismatches || mismatches
                );
              }
            }
          } catch (nvErr) {
            console.warn(`Name validation failed (episode ${ep}):`, nvErr?.message || nvErr);
          }
        }
        // Phase 2: normalize character name variants into canonical spellings.
        episodeText = normalizeEpisodeCharacterNames(
          episodeText,
          CHARACTER_NAME_REGISTRY_PATH
        );
        // Phase 4 targeted span repair (non-LLM first): repair only flagged merge/collapse spans.
        {
          const spanRepair = targetedRepairEpisodeText(episodeText, seriesNames);
          episodeText = spanRepair.text;
          sendStreamLine(res, {
            type: "span_repair",
            episode: ep,
            span_repairs_applied: spanRepair.spanRepairsApplied,
            repair_types: spanRepair.repairTypes,
            remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
          });
        }

        // Hard validation: enforce zero merged-words for credibility.
        // Retry once if any merged-word patterns remain after post-processing.
        if (hasMergedWordIssues(episodeText) || hasSentenceLevelMerges(episodeText)) {
          try {
            const spacingRetryContent =
              userContent +
              "\n\nCRITICAL FORMAT VALIDATION (do not fail this):\n" +
              "- The output MUST contain NO merged/glued words.\n" +
              "- Every English word must be separated by exactly ONE space.\n" +
              "- Do NOT remove spaces after punctuation (e.g. \".Next\" is invalid; must be \". Next\").\n" +
              "- Do NOT glue a character cue to dialogue (e.g. \"LUCAS(speaking)\" or \"LUCASHello\" is invalid).\n" +
              "- Before returning, scan the output for any pattern where a word is immediately followed by another word with no space.\n";
            const retry = await openai.chat.completions.create({
              model: FINETUNED_MODEL,
              messages: [
                { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                { role: "user", content: spacingRetryContent },
              ],
              max_tokens: 2048,
              temperature: 0.3,
              frequency_penalty: 1.0,
              presence_penalty: 0.4,
            });
            const retryRaw = retry.choices?.[0]?.message?.content;
            if (typeof retryRaw === "string" && retryRaw.trim()) {
              episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(
                    episodeText,
                    seriesNames
                  );
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM(
                      {
                        episodeText,
                        names: seriesNames,
                        episodeNumber: ep,
                      }
                    );
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(
                    `Name validation failed (episode ${ep}):`,
                    nvErr?.message || nvErr
                  );
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
              {
                const spanRepair = targetedRepairEpisodeText(episodeText, seriesNames);
                episodeText = spanRepair.text;
                sendStreamLine(res, {
                  type: "span_repair",
                  episode: ep,
                  span_repairs_applied: spanRepair.spanRepairsApplied,
                  repair_types: spanRepair.repairTypes,
                  remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
                });
              }
            }
          } catch (sErr) {
            console.error(`Merged-word spacing retry failed for episode ${ep}:`, sErr);
          }
        }

        // Quality gate: prevent "synonym vomit" / context-collapse word-list runs.
        if (hasQualityCollapse(episodeText, seriesNames)) {
          try {
            const qualityRetryContent = buildCollapseRescueUserPrompt({
              language: body.language || "EN",
              genre,
              totalEpisodes: episodeCount,
              episodeNumber: ep,
              logline,
              names: seriesNames,
              blueprint,
            });
            const retry = await openai.chat.completions.create({
              model: PLANNER_MODEL,
              messages: [
                { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                { role: "user", content: qualityRetryContent },
              ],
              max_tokens: 2048,
              temperature: 0.3,
              frequency_penalty: 1.0,
              presence_penalty: 0.6,
            });
            const retryRaw = retry.choices?.[0]?.message?.content;
            if (typeof retryRaw === "string" && retryRaw.trim()) {
              episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(
                    episodeText,
                    seriesNames
                  );
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM(
                      {
                        episodeText,
                        names: seriesNames,
                        episodeNumber: ep,
                      }
                    );
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(
                    `Name validation failed (episode ${ep}):`,
                    nvErr?.message || nvErr
                  );
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
              {
                const spanRepair = targetedRepairEpisodeText(episodeText, seriesNames);
                episodeText = spanRepair.text;
                sendStreamLine(res, {
                  type: "span_repair",
                  episode: ep,
                  span_repairs_applied: spanRepair.spanRepairsApplied,
                  repair_types: spanRepair.repairTypes,
                  remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
                });
              }
            }
          } catch (qErr) {
            console.error(`Quality retry failed for episode ${ep}:`, qErr);
          }
          // Verification policy: one more targeted repair loop before second rescue.
          if (hasQualityCollapse(episodeText, seriesNames)) {
            const spanRepair2 = targetedRepairEpisodeText(episodeText, seriesNames);
            episodeText = spanRepair2.text;
            sendStreamLine(res, {
              type: "span_repair",
              episode: ep,
              span_repairs_applied: spanRepair2.spanRepairsApplied,
              repair_types: spanRepair2.repairTypes,
              remaining_merge_count: auditMergedWords(episodeText).totals.mergedTotal,
              pass: "verification_loop",
            });
          }
          // Second rescue attempt: ultra-minimal prompt at very low temperature.
          // This runs before the deterministic fallback to give the LLM one more chance
          // to produce real screenplay content rather than a placeholder episode.
          if (hasQualityCollapse(episodeText, seriesNames)) {
            try {
              const rescue2Content = buildCollapseRescueUserPrompt({
                language: body.language || "EN",
                genre,
                totalEpisodes: episodeCount,
                episodeNumber: ep,
                logline,
                names: seriesNames,
                blueprint,
              });
              const rescue2 = await openai.chat.completions.create({
                model: PLANNER_MODEL,
                messages: [
                  { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                  { role: "user", content: rescue2Content },
                ],
                max_tokens: 2048,
                temperature: 0.15,
                frequency_penalty: 1.2,
                presence_penalty: 0.8,
              });
              const rescue2Raw = rescue2.choices?.[0]?.message?.content;
              if (typeof rescue2Raw === "string" && rescue2Raw.trim()) {
                const rescue2Text = finalizeEpisodeText(rescue2Raw.trim(), ep, seriesNames);
                if (!hasQualityCollapse(rescue2Text, seriesNames)) {
                  episodeText = rescue2Text;
                  sendStreamLine(res, {
                    type: "quality_gate",
                    episode: ep,
                    status: "second_rescue_succeeded",
                  });
                }
              }
            } catch (r2Err) {
              console.error(`Second rescue attempt failed for episode ${ep}:`, r2Err);
            }
          }
          // Last resort: deterministic fallback using blueprint plan data.
          // Better than before — uses actual episode plan details for plausible content.
          if (hasQualityCollapse(episodeText, seriesNames)) {
            const fallbackSummary =
              episodeSummaries && episodeSummaries instanceof Map
                ? episodeSummaries.get(ep)
                : "";
            const fallbackPlan =
              blueprint && Array.isArray(blueprint.episodes)
                ? blueprint.episodes.find((e) => e && e.episode === ep) || null
                : null;
            const healed = await buildCollapseSafeEpisodeFallback({
              episodeNumber: ep,
              totalEpisodes: episodeCount,
              names: seriesNames,
              genre,
              summary: fallbackSummary,
              plan: fallbackPlan,
            });
            episodeText = finalizeEpisodeText(healed, ep, seriesNames);
            sendStreamLine(res, {
              type: "quality_gate",
              episode: ep,
              status: "auto_healed",
              reason: "context_collapse_detected_after_retry",
            });
          }
        }

        // Phase 3: scene-anchor enforcement (default warn mode).
        if (ANCHOR_ENFORCEMENT_MODE !== "off") {
          let anchorReport = validateSceneAnchors(episodeText, seriesNames);
          if (!anchorReport.pass) {
            sendStreamLine(res, {
              type: "quality_gate",
              episode: ep,
              status: "anchor_warning",
              mode: ANCHOR_ENFORCEMENT_MODE,
              scene_failures: anchorReport.failureCount,
            });
          }
          if (!anchorReport.pass && ANCHOR_ENFORCEMENT_MODE === "enforce") {
            try {
              const rewritten = await rewriteEpisodeForAnchors({
                userContent,
                episodeText,
                episodeNumber: ep,
                totalEpisodes: episodeCount,
                names: seriesNames,
              });
              if (rewritten) {
                episodeText = finalizeEpisodeText(rewritten, ep, seriesNames);
                episodeText = normalizeEpisodeCharacterNames(
                  episodeText,
                  CHARACTER_NAME_REGISTRY_PATH
                );
                anchorReport = validateSceneAnchors(episodeText, seriesNames);
                sendStreamLine(res, {
                  type: "quality_gate",
                  episode: ep,
                  status: anchorReport.pass ? "anchor_auto_healed" : "anchor_enforce_partial",
                  mode: ANCHOR_ENFORCEMENT_MODE,
                  scene_failures: anchorReport.failureCount,
                });
              }
            } catch (anchorErr) {
              console.error(`Anchor rewrite failed for episode ${ep}:`, anchorErr);
            }
          }
        }

        // Phase 2: if this episode is too similar to any of the last 5 episodes, regenerate once.
        // Checks last 5 (not just last 1) to catch every-3-episode structural loops
        // (e.g. "heroine at console + signal discussion + creature alert" repeating non-consecutively).
        if (ep > 1 && episodeScriptsMemo.length > 0) {
          const recentScripts = episodeScriptsMemo.slice(-5);
          let maxScore = 0;
          let maxBlockDup = 0;
          for (const prev of recentScripts) {
            const s = repetitionScore(episodeText, prev);
            const b = maxTailBlockOverlap(prev, episodeText);
            if (s > maxScore) maxScore = s;
            if (b > maxBlockDup) maxBlockDup = b;
          }
          const score = maxScore;
          const blockDup = maxBlockDup;
          const REPETITION_THRESHOLD = 0.35;
          const BLOCK_OVERLAP_MIN = 105;
          if (score > REPETITION_THRESHOLD || blockDup >= BLOCK_OVERLAP_MIN) {
            console.warn(
              `Episode ${ep} repetition score ${score.toFixed(2)} / tail block ${blockDup} chars (vs last 5 eps) — regenerating with anti-repetition hint.`
            );
            const retryContent =
              userContent +
              "\n\nREWRITE REQUIREMENT: This draft reused too much text from the prior episode (including repeated POV or reaction paragraphs). Remove ALL duplicated material from the previous episode’s ending. Continue the timeline forward with new dialogue and action only—no paste of the same beats, crowd shots, or “only one person unmoved” blocks. New scene energy, new information, new consequences.";
            const retry = await openai.chat.completions.create({
              model: FINETUNED_MODEL,
              messages: [
                { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                { role: "user", content: retryContent },
              ],
              max_tokens: 2048,
              temperature: 0.5,
              frequency_penalty: 1.0,
              presence_penalty: 0.6,
            });
            const retryRaw = retry.choices?.[0]?.message?.content;
            if (typeof retryRaw === "string" && retryRaw.trim()) {
              episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(
                    episodeText,
                    seriesNames
                  );
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM(
                      {
                        episodeText,
                        names: seriesNames,
                        episodeNumber: ep,
                      }
                    );
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(
                    `Name validation failed (episode ${ep}):`,
                    nvErr?.message || nvErr
                  );
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
            }
          }
        }

        // Phase 2c — Structural opening similarity gate.
        // Compares the new episode's opening fingerprint against ALL prior episodes.
        // Catches same-location / same-action repeats that sentence-level scoring misses
        // (e.g. "ROYAL LIBRARY | researching/reading | skeptic_dismissal" every 4 episodes).
        if (ep > 1 && episodeRecaps.length > 0) {
          const newFp = extractOpeningFingerprint(episodeText);
          const bestMatch = findMostSimilarPriorOpening(newFp, episodeRecaps);
          const STRUCTURAL_THRESHOLD = 0.5; // location match alone hits 0.5; location+action hits 0.8
          if (bestMatch && bestMatch.score >= STRUCTURAL_THRESHOLD) {
            const matchedFp = bestMatch.fingerprint;
            console.warn(
              `Episode ${ep} opening structurally too close to ep ${bestMatch.episode} ` +
              `(score ${bestMatch.score.toFixed(2)}): ${newFp.location} | ${newFp.action} | ${newFp.dialogue_type} — regenerating.`
            );
            const structuralRetryContent =
              userContent +
              `\n\nREWRITE REQUIRED — OPENING STRUCTURE REJECTED:\n` +
              `This draft opened in "${newFp.location}" with a "${newFp.action}" beat, ` +
              `which is structurally identical to episode ${bestMatch.episode} ` +
              `("${matchedFp.location}" | "${matchedFp.action}" | "${matchedFp.dialogue_type}").\n` +
              `You MUST rewrite the opening with:\n` +
              `  1. A DIFFERENT location — not "${newFp.location}" or any location already listed in the EPISODE OPENING HISTORY above.\n` +
              `  2. A DIFFERENT first action — not "${newFp.action}".\n` +
              `  3. Continue the story's plot and stakes; do not reset to an earlier scene.\n` +
              `The rest of the episode's story beats may remain the same — only the opening scene must change.`;
            try {
              const structuralRetry = await openai.chat.completions.create({
                model: FINETUNED_MODEL,
                messages: [
                  { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                  { role: "user", content: structuralRetryContent },
                ],
                max_tokens: 2048,
                temperature: 0.6,
                frequency_penalty: 1.0,
                presence_penalty: 0.7,
              });
              const structuralRetryRaw = structuralRetry.choices?.[0]?.message?.content;
              if (typeof structuralRetryRaw === "string" && structuralRetryRaw.trim()) {
                const retried = finalizeEpisodeText(structuralRetryRaw.trim(), ep, seriesNames);
                // Only accept the retry if it actually changed the opening structure
                const retriedFp = extractOpeningFingerprint(retried);
                const retriedMatch = findMostSimilarPriorOpening(retriedFp, episodeRecaps);
                if (!retriedMatch || retriedMatch.score < STRUCTURAL_THRESHOLD) {
                  episodeText = retried;
                  sendStreamLine(res, {
                    type: "structural_retry",
                    episode: ep,
                    reason: `opening too similar to ep ${bestMatch.episode}`,
                    old_location: newFp.location,
                    new_location: retriedFp.location,
                    score_before: bestMatch.score,
                  });
                } else {
                  console.warn(
                    `Episode ${ep} structural retry still too similar (score ${retriedMatch.score.toFixed(2)}) — keeping retry anyway as best available.`
                  );
                  episodeText = retried;
                }
              }
            } catch (structuralRetryErr) {
              console.warn(`Episode ${ep} structural retry failed:`, structuralRetryErr?.message || structuralRetryErr);
            }
          }
        }

        // Phase 3b — Blueprint setting enforcement gate.
        // Only fires if the blueprint specifies a setting_focus for this episode
        // AND the generated opening doesn't land in that location.
        // Runs after Phase 2c so the latest episodeText is always checked.
        {
          const epPlan = blueprint?.episodes?.[ep - 1];
          const requiredSetting = safeStr(epPlan?.setting_focus).trim();
          if (requiredSetting) {
            const currentFp = extractOpeningFingerprint(episodeText);
            const settingCheck = blueprintSettingMatches(currentFp, requiredSetting);
            if (!settingCheck.match) {
              console.warn(
                `Episode ${ep} blueprint setting mismatch: required "${requiredSetting}" ` +
                `but opened in "${currentFp.location}" (confidence ${settingCheck.confidence.toFixed(2)}) — retrying.`
              );
              const blueprintRetryContent =
                userContent +
                `\n\nREWRITE REQUIRED — WRONG OPENING LOCATION:\n` +
                `The season blueprint requires episode ${ep} to be set in: "${requiredSetting}".\n` +
                `Your draft opened in "${currentFp.location}" instead.\n` +
                `Rules for the rewrite:\n` +
                `  1. Move the opening scene to "${requiredSetting}" — this is a hard constraint from the season plan.\n` +
                `  2. Keep all story beats, plot developments, and character decisions the same.\n` +
                `  3. Do NOT time-skip or introduce new subplots — only the opening location changes.\n` +
                `  4. The rest of the episode after the opening scene may remain largely intact.`;
              try {
                const blueprintRetry = await openai.chat.completions.create({
                  model: FINETUNED_MODEL,
                  messages: [
                    { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                    { role: "user", content: blueprintRetryContent },
                  ],
                  max_tokens: 2048,
                  temperature: 0.5,
                  frequency_penalty: 1.0,
                  presence_penalty: 0.6,
                });
                const blueprintRetryRaw = blueprintRetry.choices?.[0]?.message?.content;
                if (typeof blueprintRetryRaw === "string" && blueprintRetryRaw.trim()) {
                  episodeText = finalizeEpisodeText(blueprintRetryRaw.trim(), ep, seriesNames);
                  const retriedFp = extractOpeningFingerprint(episodeText);
                  const retriedCheck = blueprintSettingMatches(retriedFp, requiredSetting);
                  sendStreamLine(res, {
                    type: "blueprint_setting_retry",
                    episode: ep,
                    required_setting: requiredSetting,
                    original_location: currentFp.location,
                    retried_location: retriedFp.location,
                    match_after_retry: retriedCheck.match,
                    confidence_after_retry: retriedCheck.confidence,
                  });
                }
              } catch (blueprintRetryErr) {
                console.warn(`Episode ${ep} blueprint setting retry failed:`, blueprintRetryErr?.message || blueprintRetryErr);
              }
            }
          }
        }

        // Hard safeguard: prevent the model from inventing/using "Victor" unless explicitly provided.
        if (!victorAllowed && includesWord(episodeText, "Victor")) {
          const replacement = pickReplacementNameForVictor();
          console.warn(`Episode ${ep} used forbidden name Victor; regenerating with rename to ${replacement}.`);
          const renameRetryContent =
            userContent +
            `\n\nREWRITE REQUIREMENT (name ban): The draft used the forbidden name "Victor". ` +
            `Rewrite the episode and rename ANY character named "Victor" to "${replacement}" (and adjust dialogue/action accordingly). ` +
            `Do NOT introduce any new protagonists. Keep the heroine and the two male leads as the core cast. Do not change their names.`;
          try {
            const retry = await openai.chat.completions.create({
              model: FINETUNED_MODEL,
              messages: [
                { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
                { role: "user", content: renameRetryContent },
              ],
              max_tokens: 2048,
              temperature: 0.5,
              frequency_penalty: 1.0,
              presence_penalty: 0.6,
            });
            const retryRaw = retry.choices?.[0]?.message?.content;
            if (typeof retryRaw === "string" && retryRaw.trim()) {
              episodeText = finalizeEpisodeText(retryRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(
                    episodeText,
                    seriesNames
                  );
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM(
                      {
                        episodeText,
                        names: seriesNames,
                        episodeNumber: ep,
                      }
                    );
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(
                    `Name validation failed (episode ${ep}):`,
                    nvErr?.message || nvErr
                  );
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
            }
          } catch (e) {
            console.error(`Victor rename retry failed for episode ${ep}:`, e);
          }
          // Last resort: if still present, do a conservative replace of whole-word Victor.
          if (includesWord(episodeText, "Victor")) {
            const replacement2 = replacement || "Damien";
            episodeText = episodeText.replace(/\bVictor\b/g, replacement2);
          }
        }

        // Tag big events in this episode for future anti-repetition guidance.
        const eventTags = tagEpisodeEvents(episodeText);

        // Final-episode pass: lightly edit the ending away from cliffhangers into true resolution.
        if (ep === episodeCount && typeof episodeText === "string" && episodeText.trim()) {
          try {
            const edit = await openai.chat.completions.create({
              model: PLANNER_MODEL,
              messages: [
                { role: "system", content: ENDING_EDIT_SYSTEM_PROMPT },
                {
                  role: "user",
                  content:
                    "Here is the full script for the FINAL episode of the season. " +
                    "Lightly edit ONLY as needed so that the ending is a true resolution (no new threats, no teasers), " +
                    "and return the complete edited script:\n\n" +
                    episodeText,
                },
              ],
              max_tokens: 2048,
              temperature: 0.3,
            });
            const editedRaw = edit.choices?.[0]?.message?.content;
            if (typeof editedRaw === "string" && editedRaw.trim()) {
              episodeText = finalizeEpisodeText(editedRaw.trim(), ep, seriesNames);
              if (shouldRunNameValidation) {
                try {
                  const mismatches = detectMainTrioNameMismatches(
                    episodeText,
                    seriesNames
                  );
                  if (mismatches.length > 0) {
                    episodeText = applyMainTrioNameCorrections(episodeText, mismatches);
                    const report = await validateMainTrioNameConsistencyWithLLM(
                      {
                        episodeText,
                        names: seriesNames,
                        episodeNumber: ep,
                      }
                    );
                    if (report && report.ok === false) {
                      console.warn(
                        `Name consistency mismatches (episode ${ep}):`,
                        report.mismatches || mismatches
                      );
                    }
                  }
                } catch (nvErr) {
                  console.warn(
                    `Name validation failed (episode ${ep}):`,
                    nvErr?.message || nvErr
                  );
                }
              }
              episodeText = normalizeEpisodeCharacterNames(
                episodeText,
                CHARACTER_NAME_REGISTRY_PATH
              );
            }
          } catch (editErr) {
            console.error(`Ending edit failed for final episode ${ep}:`, editErr);
          }
        }

        // If the ending-edit step reintroduced the forbidden name, strip it (rare but possible).
        if (!victorAllowed && includesWord(episodeText, "Victor")) {
          episodeText = episodeText.replace(/\bVictor\b/g, pickReplacementNameForVictor());
        }

        // Phase 1: audit character cue name variants and keep a registry on disk.
        try {
          await updateCharacterNameRegistryFromEpisode({
            episodeText,
            registryPath: CHARACTER_NAME_REGISTRY_PATH,
            seedCanonicalHeaderNames: [
              seriesNames?.heroine,
              seriesNames?.coldCeo,
              seriesNames?.warmFriend,
            ].filter(Boolean),
          });
        } catch (regErr) {
          console.warn("Name registry update failed:", regErr?.message || regErr);
        }

        // Summarize this episode for future context (best-effort).
        try {
          const recap = await summarizeEpisode({
            episodeNumber: ep,
            text: episodeText,
          });
          if (recap) {
            episodeRecaps.push({
              episode: ep,
              recap,
              tags: eventTags,
              openingBeat: extractOpeningBeat(episodeText),
              openingFingerprint: extractOpeningFingerprint(episodeText),
            });
            sendStreamLine(res, {
              type: "recap",
              episode: ep,
              recap,
            });
          }
        } catch (recErr) {
          console.error(`Recap generation failed for episode ${ep}:`, recErr);
        }

        // Structured state summary for context-windowed chaining.
        try {
          const state = await summarizeEpisodeState({
            episodeNumber: ep,
            text: episodeText,
          });
          if (state) {
            episodeStateMemo.push(state);
            sendStreamLine(res, { type: "episode_state", episode: ep, ok: true });
          } else {
            sendStreamLine(res, { type: "episode_state", episode: ep, ok: false });
          }
        } catch (stateErr) {
          console.error(`Episode state summary failed for episode ${ep}:`, stateErr);
          sendStreamLine(res, { type: "episode_state", episode: ep, ok: false });
        }

        episodeScriptsMemo.push(episodeText);
        sendStreamLine(res, { type: "episode", episode: ep, text: episodeText });
      } catch (epErr) {
        console.error(`Episode ${ep} error:`, epErr);
        const fallback = `[Episode ${ep} failed to generate.]`;
        episodeScriptsMemo.push(fallback);
        sendStreamLine(res, { type: "episode", episode: ep, text: fallback });
      }
    }

    const lang = String(body.language || "EN").toUpperCase();
    const wantZh =
      body.translateToChinese !== false &&
      lang !== "ZH" &&
      episodeScriptsMemo.length > 0;
    if (wantZh) {
      const total = episodeScriptsMemo.length;
      let hardStop = false;
      for (let i = 0; i < total; i++) {
        if (hardStop) break;
        const epNum = i + 1;
        try {
          // sendStreamLine is inside the try so a connection drop is caught here
          // instead of escaping to the outer catch and killing remaining episodes.
          sendStreamLine(res, { type: "translation_progress", episode: epNum, total });
          const zh = await translateEpisodeScriptToChinese(epNum, total, episodeScriptsMemo[i]);
          const text = zh || `[Episode ${epNum} — translation produced no text; see English PDF.]`;
          sendStreamLine(res, { type: "episode_zh", episode: epNum, text });
        } catch (trErr) {
          console.error(`Chinese translation failed for episode ${epNum}:`, trErr);
          const msg = safeStr(trErr?.message) || "translation failed";
          const status = trErr?.status;
          // Hard quota (account out of credits) — no point continuing
          const isHardQuota = /insufficient_quota/i.test(msg) || (status === 429 && /quota/i.test(msg));
          try {
            sendStreamLine(res, { type: "translation_error", episode: epNum, message: msg });
            sendStreamLine(res, {
              type: "episode_zh",
              episode: epNum,
              text: `[Episode ${epNum} — translation failed: ${msg}]`,
            });
          } catch (_writeErr) {
            // Client disconnected — nothing we can do, stop cleanly
            hardStop = true;
          }
          if (isHardQuota) hardStop = true;
        }
      }
    }

    sendStreamLine(res, { type: "done", model: FINETUNED_MODEL });
  } catch (err) {
    console.error(err);
    sendStreamLine(res, { type: "error", message: err.message || "Generation failed" });
    sendStreamLine(res, { type: "done", model: FINETUNED_MODEL });
  } finally {
    res.end();
  }
});

function parseEpisodesFromEnglishScript(scriptText) {
  const raw = safeStr(scriptText);
  if (!raw) return null;
  const re = /^EPISODE\s+(\d+)\s*$/gm;
  const matches = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    const ep = parseInt(m[1], 10);
    if (!Number.isFinite(ep)) continue;
    matches.push({ episode: ep, index: m.index });
  }
  if (!matches.length) return null;

  const totalEpisodes = Math.max(...matches.map((x) => x.episode));
  const episodes = matches
    .map((match, i) => {
      const start = match.index;
      const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
      const chunk = raw.slice(start, end).trimEnd();
      const lines = chunk.split(/\r?\n/);
      const body = lines.slice(1).join("\n").trim();
      return { episode: match.episode, englishText: body };
    })
    .sort((a, b) => a.episode - b.episode);

  return { totalEpisodes, episodes };
}

app.post("/translate-to-chinese", requireAuth, async (req, res) => {
  const body = req.body || {};
  const englishText = safeStr(body.text || body.script);
  const parsed = parseEpisodesFromEnglishScript(englishText);

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  if (!parsed) {
    sendStreamLine(res, {
      type: "translation_error",
      message: "Could not parse episodes. Make sure the English script includes 'EPISODE N' headings.",
    });
    sendStreamLine(res, { type: "done" });
    return res.end();
  }

  const { totalEpisodes, episodes } = parsed;
  try {
    for (const ep of episodes) {
      sendStreamLine(res, {
        type: "translation_progress",
        episode: ep.episode,
        total: totalEpisodes,
      });
      try {
        const zh = await translateEpisodeScriptToChinese(
          ep.episode,
          totalEpisodes,
          ep.englishText
        );
        sendStreamLine(res, {
          type: "episode_zh",
          episode: ep.episode,
          text: zh || `[Episode ${ep.episode} — translation produced no text.]`,
        });
      } catch (trErr) {
        const msg = safeStr(trErr?.message) || "translation failed";
        const status = trErr?.status;
        const isQuota = status === 429 || /429|quota/i.test(msg);
        sendStreamLine(res, {
          type: "translation_error",
          episode: ep.episode,
          message: msg,
        });
        if (isQuota) break;
      }
    }
  } catch (outerErr) {
    console.error("Translation endpoint failed:", outerErr);
    sendStreamLine(res, {
      type: "translation_error",
      message: safeStr(outerErr?.message) || "Translation failed",
    });
  }

  sendStreamLine(res, { type: "done", model: TRANSLATION_MODEL });
  res.end();
});

app.get("/health", (_, res) => {
  res.json({ ok: true, model: FINETUNED_MODEL });
});

// ---------------------------------------------------------------------------
// Genre-based summary and ending suggestions
// ---------------------------------------------------------------------------
const SUMMARIES_PATH = join(__dirname, "data", "summaries_by_genre.json");
const ENDINGS_PATH = join(__dirname, "data", "endings_by_genre.json");

function loadSummariesByGenre() {
  try {
    const raw = fs.readFileSync(SUMMARIES_PATH, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

function loadEndingsByGenre() {
  try {
    const raw = fs.readFileSync(ENDINGS_PATH, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

/** GET /summaries?genre=Romance — list all summaries for that genre */
app.get("/summaries", (req, res) => {
  const genre = String(req.query.genre || "").trim() || "Romance";
  const data = loadSummariesByGenre();
  const summaries = Array.isArray(data[genre]) ? data[genre] : [];
  res.json({ genre, summaries });
});

/** GET /logline/random?genre=Romance — procedurally generated logline (never repeats) */
app.get("/logline/random", (req, res) => {
  const genre = String(req.query.genre || "").trim() || "Romance";
  try {
    const logline = generateLogline(genre);
    res.json({ genre, logline });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /logline/genres — list supported genres for procedural generation */
app.get("/logline/genres", (_req, res) => {
  res.json({ genres: SUPPORTED_GENRES });
});

/** GET /summaries/random?genre=Romance — one random summary for that genre */
app.get("/summaries/random", (req, res) => {
  const genre = String(req.query.genre || "").trim() || "Romance";
  const data = loadSummariesByGenre();
  const list = Array.isArray(data[genre]) ? data[genre] : [];
  const summary = list.length > 0 ? list[Math.floor(Math.random() * list.length)] : "";
  res.json({ genre, summary });
});

const PORT = process.env.PORT || 3001;
const start = async () => {
  try {
    await initDb();
    console.log("Postgres DB initialized.");
  } catch (e) {
    console.warn("Postgres init skipped/failed:", e?.message || e);
  }
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Using model: ${FINETUNED_MODEL}`);
  });
};
start();
