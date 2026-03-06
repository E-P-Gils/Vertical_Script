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

The user will give you control tags (language, genre, total episode count, episode index) and a short series summary.

You must write ONE EPISODE of a short-form / vertical drama script with these rules:
- The clear protagonist is a young woman who starts as an underdog (socially, financially, or in status).
- Most negative events, misunderstandings, and external pressure fall on HER shoulders; the audience experiences the story primarily through her emotions and choices.
- There is at least one handsome, powerful man who is drawn to her; very often there are TWO male leads whose rivalry or tension revolves around her.
- The long-term arc is that she will eventually marry into money/power (e.g., a rich or high-status man), but do NOT resolve this too quickly—keep the romantic stakes and uncertainty alive across episodes.
- Keep the heroine active and resilient: she faces humiliation, setbacks, and schemes, but gradually gains confidence, agency, and leverage.
- Use screenplay-style scene headings like "INT. LOCATION - DAY" or "EXT. LOCATION - NIGHT".
- Mix vivid action lines and natural dialogue (CHARACTER NAME in caps, then their lines).
- Keep the episode focused, with 2–5 short scenes.
- End the episode on a clear hook or cliffhanger centred on the heroine (a shocking reveal, emotional blow, or new threat/opportunity that directly affects her).

Output only script text for that episode. Do NOT output JSON, arrays, or any extra commentary.`;

function buildEpisodePromptText({
  language,
  genre,
  totalEpisodes,
  episodeNumber,
  logline,
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
  if (cleanLogline) {
    lines.push(`[LOGLINE] ${cleanLogline}`);
  }
  lines.push(
    `Write episode ${ep} of ${total} for this vertical drama. ` +
      `Keep characters, tone, and premise consistent with the logline. ` +
      `End on a strong cliffhanger or unresolved emotional beat.`
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

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  try {
    for (let ep = 1; ep <= episodeCount; ep++) {
      sendStreamLine(res, { type: "progress", episode: ep, total: episodeCount });

      try {
        const userContent = buildEpisodePromptText({
          language: body.language || "EN",
          genre,
          totalEpisodes: episodeCount,
          episodeNumber: ep,
          logline,
        });

        const completion = await openai.chat.completions.create({
          model: FINETUNED_MODEL,
          messages: [
            { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          max_tokens: 2048,
          temperature: 0.6,
          frequency_penalty: 0.8,
          presence_penalty: 0.15,
        });

        const rawContent = completion.choices?.[0]?.message?.content;
        const episodeText =
          typeof rawContent === "string" && rawContent.trim()
            ? rawContent.trim()
            : `[Episode ${ep} — no content]`;
        sendStreamLine(res, { type: "episode", episode: ep, text: episodeText });
      } catch (epErr) {
        console.error(`Episode ${ep} error:`, epErr);
        sendStreamLine(res, { type: "episode", episode: ep, text: `[Episode ${ep} failed to generate.]` });
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
