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

/**
 * Build control prompt for the fine-tuned model.
 * Matches the format used in training: [LANG=...] [GENRE=...] [EPISODES=...] [TITLE] [LOGLINE] [START_SCRIPT]
 */
function buildPrompt(body) {
  const lang = (body.language || "EN").toUpperCase() === "ZH" ? "ZH" : "EN";
  const genre =
    (body.genre || "NON_WEREWOLF").toUpperCase() === "WEREWOLF"
      ? "WEREWOLF"
      : "NON_WEREWOLF";
  const episodes = Math.max(1, parseInt(body.episodeCount, 10) || 10);
  const title = body.title ? body.title.trim() : "Generated Script";
  const logline = (body.logline || "").trim().slice(0, 1500);

  const lines = [
    `[LANG=${lang}] [GENRE=${genre}] [EPISODES=${episodes}]`,
    `[TITLE] ${title}`,
    logline ? `[LOGLINE] ${logline}` : "[LOGLINE] ",
    "[START_SCRIPT]",
  ];
  return lines.join("\n");
}

app.post("/generate", async (req, res) => {
  try {
    const prompt = buildPrompt(req.body);

    const completion = await openai.chat.completions.create({
      model: FINETUNED_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a vertical script generator. Given control tags (language, genre, episode count, optional logline), output a complete vertical/short-form script with a coherent beginning, middle, and end. Use scene headings (INT./EXT. LOCATION - DAY/NIGHT), vivid action blocks, and natural dialogue (CHARACTER then lines). Avoid meta text like 'End of Free Preview'. Avoid looping or repeating the same sentence many times. Output only the script text, no commentary.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 8000,
      temperature: 0.5,
      frequency_penalty: 1.0,
      presence_penalty: 0.2,
    });

    const text =
      completion.choices?.[0]?.message?.content?.trim() || "";
    res.json({ script: text, model: FINETUNED_MODEL });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: err.message || "Generation failed" });
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
