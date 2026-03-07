/**
 * Backend for vertical script generator.
 * Load .env from project root; expects OPENAI_API_KEY and optional OPENAI_FINETUNED_MODEL.
 */
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getSeriesNames } from "./nameEngine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
dotenv.config({ path: join(rootDir, ".env") });

const app = express();
const corsOptions = {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FINETUNED_MODEL =
  process.env.OPENAI_FINETUNED_MODEL ||
  "ft:gpt-4.1-mini-2025-04-14:personal:verticalinfinitev2:DFJD8T6F";
const PLANNER_MODEL =
  process.env.OPENAI_PLANNER_MODEL || "gpt-4.1-mini";
const RECAP_MODEL =
  process.env.OPENAI_RECAP_MODEL || PLANNER_MODEL;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  // Allow slower responses on free Render / high latency routes
  timeout: 600_000, // 10 minutes in milliseconds
  maxRetries: 2,
});

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

You must output a single JSON object (no other text, no markdown) with this exact structure:

{
  "series_title": "A short title for the series",
  "heroine": "Full name as given",
  "male1": "Full name as given",
  "male2": "Full name as given",
  "genre": "WEREWOLF or NON_WEREWOLF",
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
      "cliffhanger": "One sentence: how the episode ends to hook the next"
    }
  ]
}

Rules:
- Produce exactly one object per episode in order (episode 1 through the total given).
- arc_phase must follow the season arc: episodes 1-5 hook, 6-20 escalation, 21-40 turning_point, 41-55 endgame, 56-60 finale.
- Same heroine and two male leads in every episode; their states evolve but names never change.
- Story must have a clear beginning, middle, and end across the full season; no resets.
- For episodes 1-10 especially: plan a strong OPENING hook (e.g. intimacy/tension, heroine bullied or in danger, male lead’s presence/physical appeal) and a strong CLOSING hook (e.g. male lead saves/defends her, rescue, charged moment, reveal). PG-13 only.
- Output only valid JSON. No commentary before or after.`;

function buildBlueprintPrompt({ logline, names, genre, episodeCount }) {
  const total = Math.max(1, Math.min(120, episodeCount || 60));
  const heroine = (names && names.heroine) || "EMMA LIN";
  const male1 = (names && names.coldCeo) || "ADRIAN LUO";
  const male2 = (names && names.warmFriend) || "LIAM CHEN";
  const familyName = names && names.familyName;
  const corporationName = names && names.corporationName;
  const genreTag = String(genre || "NON_WEREWOLF").toUpperCase() === "WEREWOLF" ? "WEREWOLF" : "NON_WEREWOLF";
  const cleanLogline = safeStr(logline).slice(0, 1500);

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

async function generateSeasonBlueprint({ episodeCount, logline, genre, names }) {
  const userContent = buildBlueprintPrompt({
    logline,
    names,
    genre,
    episodeCount,
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
  return blueprint;
}

const RECAP_SYSTEM_PROMPT = `You are an assistant that summarizes vertical drama episodes.

Given the full script text for ONE episode, write a single concise sentence (15–35 words) that describes what happens to the heroine and how the episode ends, focusing on the emotional and plot cliffhanger.

Output ONLY the sentence. No bullet points, no extra commentary.`;

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

function formatRecapContext(recaps, episodeNumber) {
  if (!Array.isArray(recaps) || !recaps.length) return "";
  const prev = recaps
    .filter((r) => typeof r.episode === "number" && r.episode < episodeNumber)
    .slice(-3);
  if (!prev.length) return "";
  const lines = ["RECENT EPISODE RECAPS (actual story so far):"];
  for (const r of prev) {
    lines.push(`  Ep ${r.episode}: ${r.recap}`);
  }
  return lines.join("\n");
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

// Plain-text episode generation (no JSON parsing) ---------------------------

const EPISODE_TEXT_SYSTEM_PROMPT = `You are a vertical drama scriptwriter focused on female-led romance dramas.

The user will give you control tags (language, genre, total episode count, episode index), a short series summary, and THREE MAIN CHARACTER NAMES via tags like:
[HEROINE=...] [MALE1=...] [MALE2=...]

This is always ONE SINGLE SERIES told over many episodes. All  episodes in the run must share:
- The same heroine (female protagonist), the same two main male leads, the same supporting cast names.
- A continuous plot line with clear beginning, middle, and end across the whole season.
- Stable relationships and history between characters that evolve, but are never reset or forgotten.

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
- Every episode must have a HOOK at the beginning and a HOOK at the end (especially in the first 10 episodes), but keep them emotionally driven and grounded. Opening hooks should feel like a sharp emotional moment: an awkward intimacy beat, the heroine being subtly bullied or underestimated, a charged first encounter, or a small but vivid humiliation that makes us care. Closing hooks should be light but addictive: a promise, a tease, a jealousy beat, a sudden confession or near-confession, or the hint of danger/competition around love or status.
- Avoid graphic violence, gore, or long slapstick brawls. Do NOT ramble or list random objects, professions, or technical details; stay tightly focused on the characters, their feelings, and the immediate scene.
- End the episode on a clear, clean hook or cliffhanger centred on the heroine (an emotional blow, surprising gesture, or new threat/opportunity that directly affects her).

ANTI-REPETITION AND FORMAT (critical — vertical scripts are sparse):
- Dialogue must dominate: each scene should be mostly character lines, not long prose.
- Action/stage direction: maximum 1–2 sentences per block. Never write long descriptive paragraphs; break into short beats (e.g. "She turns. He steps closer.").
- No adjective stacking: do NOT chain synonyms (e.g. incredible, extraordinary, miraculous, divine, magnificent). Use one strong word, then move on. Never repeat the same type of descriptor in a row.
- No lists of similar words or emotional synonyms. If you need intensity, use a single clear word and then action or dialogue.
- Each beat should be action or dialogue, not a run of descriptive adjectives.

Output only script text for that episode. Do NOT output JSON, arrays, or any extra commentary.`;

function formatBlueprintContext(blueprint, episodeNumber) {
  if (!blueprint || !Array.isArray(blueprint.episodes)) return "";
  const total = blueprint.episodes.length;
  const ep = Math.max(1, Math.min(episodeNumber, total));
  const lines = [];

  if (ep > 1) {
    lines.push("PREVIOUS EPISODES (already happened — continue from here):");
    const start = Math.max(0, ep - 8);
    for (let i = start; i < ep - 1; i++) {
      const plan = blueprint.episodes[i];
      if (plan && (plan.title || plan.main_conflict)) {
        const title = plan.title || `Episode ${(plan.episode ?? i + 1)}`;
        const oneLine = plan.main_conflict || plan.cliffhanger || "";
        lines.push(`  Episode ${(plan.episode ?? i + 1)}: ${title}. ${oneLine}`);
      }
    }
    lines.push("");
  }

  const plan = blueprint.episodes[ep - 1];
  if (plan && typeof plan === "object") {
    lines.push("THIS EPISODE'S PLAN (follow this beat for beat):");
    lines.push(`  Title: ${plan.title || `Episode ${ep}`}`);
    if (plan.heroine_state) lines.push(`  Heroine state: ${plan.heroine_state}`);
    if (plan.male1_state) lines.push(`  Male lead 1: ${plan.male1_state}`);
    if (plan.male2_state) lines.push(`  Male lead 2: ${plan.male2_state}`);
    if (plan.main_conflict) lines.push(`  Main conflict: ${plan.main_conflict}`);
    if (plan.key_events && plan.key_events.length)
      lines.push(`  Key events: ${plan.key_events.join("; ")}`);
    if (plan.twist_or_reveal) lines.push(`  Twist/reveal: ${plan.twist_or_reveal}`);
    if (plan.cliffhanger) lines.push(`  End on cliffhanger: ${plan.cliffhanger}`);
  }

  return lines.length ? lines.join("\n") : "";
}

// How many prior episodes to include in full for continuation (token budget).
const PREVIOUS_EPISODES_IN_CONTEXT = 1;

function buildEpisodePromptText({
  language,
  genre,
  totalEpisodes,
  episodeNumber,
  logline,
  names,
  blueprint,
  recaps,
  previousEpisodeScripts = [],
}) {
  const langTag = String(language || "EN").toUpperCase() === "ZH" ? "ZH" : "EN";
  const genreTag =
    String(genre || "NON_WEREWOLF").toUpperCase() === "WEREWOLF"
      ? "WEREWOLF"
      : "NON_WEREWOLF";
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
    if (names.corporationName) {
      lines.push(
        `For finance/boardroom storylines use this corporation consistently: ${names.corporationName}.`
      );
    }
  }
  if (cleanLogline) {
    lines.push(`[LOGLINE] ${cleanLogline}`);
  }

  const blueprintContext = formatBlueprintContext(blueprint, ep);
  const recapContext = formatRecapContext(recaps, ep);
  if (blueprintContext || recapContext) {
    lines.push("");
    if (blueprintContext) lines.push(blueprintContext);
    if (recapContext) {
      if (blueprintContext) lines.push("");
      lines.push(recapContext);
    }
    lines.push("");
  }

  // Dynamic programming / memo: pass the actual script of the previous episode(s)
  // so the model continues from the exact final line (critical for paid cliffhangers).
  if (ep > 1 && Array.isArray(previousEpisodeScripts) && previousEpisodeScripts.length > 0) {
    const toInclude = previousEpisodeScripts.slice(-PREVIOUS_EPISODES_IN_CONTEXT);
    const label = toInclude.length === 1 ? "PREVIOUS EPISODE" : "PREVIOUS EPISODES";
    lines.push("");
    lines.push(
      `CONTINUATION REQUIREMENT (critical for this format): The audience has just paid to see what happens next. Below is the exact end of the ${label}. You MUST continue the story immediately from the next moment—same scene, same characters, same emotional beat. Do not time-skip, change location, or restart; pick up from the last line or action and continue.`
    );
    lines.push("");
    toInclude.forEach((script, i) => {
      const which = toInclude.length === 1 ? "PREVIOUS EPISODE" : `EPISODE ${ep - toInclude.length + i}`;
      lines.push(`--- END OF ${which} ---`);
      lines.push(safeStr(script).trim());
      lines.push(`--- END OF ${which} ---`);
      lines.push("");
    });
    lines.push(`Write episode ${ep} now, continuing directly from the text above.`);
    lines.push("");
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

  if (ep <= 10) {
    lines.push(
      "HOOK REQUIREMENT (early episodes): Start with a small but sharp emotional moment (awkward intimacy, subtle bullying, jealousy, or a vivid humiliation) and end with a light but addictive hook (a tease, promise, jealousy beat, or near-confession). No graphic violence, no gore, no long slapstick fights; stay close to the characters’ feelings."
    );
  }

  lines.push(
    `This is episode ${ep} of ${total} of ONE continuous story about the same heroine and the same two male leads. ` +
      `Previous episodes are already written; do NOT restart the story, change character names, or reset their relationships. ` +
      (blueprintContext
        ? `Follow the season outline and THIS EPISODE'S PLAN above. `
        : "") +
      (ep > 1 && previousEpisodeScripts.length > 0
        ? `You have been given the exact previous episode text above—continue from its last line. `
        : "") +
      `Treat this as the ${phase}, and continue the same plot line. ` +
      `Maintain consistency with earlier implied events and keep the tone and premise aligned with the logline. ` +
      `End on a strong cliffhanger or unresolved emotional beat for the heroine. ` +
      `Keep prose sparse: short action beats, dialogue-led scenes, no adjective stacking or synonym chains.`
  );
  return lines.join("\n");
}

function sendStreamLine(res, obj) {
  res.write(JSON.stringify(obj) + "\n");
}

app.post("/generate", async (req, res) => {
  const body = req.body || {};
  const episodeCount = Math.max(1, Math.min(120, parseInt(body.episodeCount, 10) || 60));
  const logline = safeStr(body.logline).slice(0, 1500);
  const genre = String(body.genre || "NON_WEREWOLF").toUpperCase() === "WEREWOLF" ? "WEREWOLF" : "NON_WEREWOLF";
  const seriesNames = getSeriesNames(genre);

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  try {
    let blueprint = null;
    const episodeRecaps = [];
    try {
      blueprint = await generateSeasonBlueprint({
        episodeCount,
        logline,
        genre,
        names: seriesNames,
      });
      sendStreamLine(res, {
        type: "blueprint",
        ok: true,
        episodes: Array.isArray(blueprint.episodes)
          ? blueprint.episodes.length
          : 0,
      });
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

    for (let ep = 1; ep <= episodeCount; ep++) {
      sendStreamLine(res, { type: "progress", episode: ep, total: episodeCount });

      try {
        const userContent = buildEpisodePromptText({
          language: body.language || "EN",
          genre,
          totalEpisodes: episodeCount,
          episodeNumber: ep,
          logline,
          names: seriesNames,
          blueprint,
          recaps: episodeRecaps,
          previousEpisodeScripts: episodeScriptsMemo,
        });

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

        const rawContent = completion.choices?.[0]?.message?.content;
        const episodeText =
          typeof rawContent === "string" && rawContent.trim()
            ? rawContent.trim()
            : `[Episode ${ep} — no content]`;

        // Summarize this episode for future context (best-effort).
        try {
          const recap = await summarizeEpisode({
            episodeNumber: ep,
            text: episodeText,
          });
          if (recap) {
            episodeRecaps.push({ episode: ep, recap });
            sendStreamLine(res, {
              type: "recap",
              episode: ep,
              recap,
            });
          }
        } catch (recErr) {
          console.error(`Recap generation failed for episode ${ep}:`, recErr);
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
    sendStreamLine(res, { type: "done", model: FINETUNED_MODEL });
  } catch (err) {
    console.error(err);
    sendStreamLine(res, { type: "error", message: err.message || "Generation failed" });
    sendStreamLine(res, { type: "done", model: FINETUNED_MODEL });
  } finally {
    res.end();
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true, model: FINETUNED_MODEL });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Using model: ${FINETUNED_MODEL}`);
});
