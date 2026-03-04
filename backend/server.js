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
app.use(cors());
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

function blocksToScriptText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  const lines = [];
  let lastScene = null;
  for (const b of blocks) {
    const sceneId = b.scene_id || "";
    if (sceneId && sceneId !== lastScene) {
      const loc = (b.location || "INT. SCENE - DAY").trim();
      lines.push(loc.startsWith("INT") || loc.startsWith("EXT") ? loc : `INT. ${loc} - DAY`);
      lastScene = sceneId;
    }
    const type = (b.type || b.block_type || "action").toLowerCase();
    const text = (b.text || "").trim();
    if (!text) continue;
    if (type === "dialogue" && b.speaker) {
      lines.push(String(b.speaker).toUpperCase());
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

app.post("/generate", async (req, res) => {
  try {
    const episodeCount = Math.max(1, Math.min(120, parseInt(req.body.episodeCount, 10) || 60));
    const logline = (req.body.logline || "").trim().slice(0, 1500);
    const genre = (req.body.genre || "NON_WEREWOLF").toUpperCase() === "WEREWOLF" ? "WEREWOLF" : "NON_WEREWOLF";

    const fullScriptParts = [];

    for (let ep = 1; ep <= episodeCount; ep++) {
      const input = buildEpisodeInput(ep, episodeCount, logline, genre);
      const userContent = JSON.stringify(input);

      const completion = await openai.chat.completions.create({
        model: FINETUNED_MODEL,
        messages: [
          { role: "system", content: V2_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: 4096,
        temperature: 0.6,
        frequency_penalty: 0.8,
        presence_penalty: 0.15,
      });

      const content = completion.choices?.[0]?.message?.content?.trim() || "";
      const blocks = parseBlocksFromContent(content);
      const episodeText = blocks ? blocksToScriptText(blocks) : content;
      fullScriptParts.push(`EPISODE ${ep}\n\n${episodeText}`);
    }

    const script = fullScriptParts.join("\n\n");
    res.json({ script, model: FINETUNED_MODEL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Generation failed" });
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
