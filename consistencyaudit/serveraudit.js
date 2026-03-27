// ‎backend/server.js‎
// +112
// -13
// Lines changed: 112 additions & 13 deletions
// Original file line number	Diff line number	Diff line change
// @@ -5,6 +5,7 @@
// import cors from "cors";
// import dotenv from "dotenv";
// import express from "express";
// import fs from "fs";
// import OpenAI from "openai";
// import { fileURLToPath } from "url";
// import { dirname, join } from "path";
// @@ -27,7 +28,7 @@ app.use(express.json());
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// const FINETUNED_MODEL =
//   process.env.OPENAI_FINETUNED_MODEL ||
//   "ft:gpt-4.1-mini-2025-04-14:personal:verticalinfinitev2:DFJD8T6F";
//   "ft:gpt-4.1-mini-2025-04-14:personal:vertical-genre:DJdSjUra";
// const PLANNER_MODEL =
//   process.env.OPENAI_PLANNER_MODEL || "gpt-4.1-mini";
// const RECAP_MODEL =
// @@ -135,6 +136,8 @@ Rules:
// - Same heroine and two male leads in every episode; their states evolve but names never change.
// - Story must have a clear beginning, middle, and end across the full season; no resets.
// - For episodes 1-10 especially: plan a strong OPENING hook (e.g. intimacy/tension, heroine bullied or in danger, male lead’s presence/physical appeal) and a strong CLOSING hook (e.g. male lead saves/defends her, rescue, charged moment, reveal). PG-13 only.
// - Vary the main conflict type across the season: every 3–5 episodes, rotate between family pressure, money/business/contracts, social reputation/public humiliation, secrets/reveals, rival schemes, and romantic tension. Do NOT let 4+ episodes in a row revolve around the same physical scenario (e.g. chase → corner → forced kiss).
// - Physical closeness beats (kisses, grabs, cornering) should be planned as spikes, not the only conflict: after early hook episodes, focus escalation on external stakes (family approval, deals, inheritances, pack politics, social status) and heroine leverage.
// - Output only valid JSON. No commentary before or after.`;

// function buildBlueprintPrompt({ logline, names, genre, episodeCount }) {
// @@ -144,7 +147,7 @@ function buildBlueprintPrompt({ logline, names, genre, episodeCount }) {
//   const male2 = (names && names.warmFriend) || "LIAM CHEN";
//   const familyName = names && names.familyName;
//   const corporationName = names && names.corporationName;
//   const genreTag = String(genre || "NON_WEREWOLF").toUpperCase() === "WEREWOLF" ? "WEREWOLF" : "NON_WEREWOLF";
//   const genreTag = String(genre || "Romance").trim() || "Romance";
//   const cleanLogline = safeStr(logline).slice(0, 1500);

//   const lines = [
// @@ -327,6 +330,28 @@ function blocksToScriptText(blocks) {
//   return lines.join("\n");
// }

// // Simple repetition score between two episode scripts.
// // Splits into sentences, normalises, and computes overlap ratio.
// function repetitionScore(currentText, previousText) {
//   if (!currentText || !previousText) return 0;
//   const splitSentences = (txt) =>
//     txt
//       .split(/[\.\?!\n]+/g)
//       .map((s) => s.trim().toLowerCase())
//       .filter((s) => s.length > 20);
//   const curSentences = splitSentences(currentText);
//   const prevSentences = splitSentences(previousText);
//   if (!curSentences.length || !prevSentences.length) return 0;
//   const prevSet = new Set(prevSentences);
//   let overlap = 0;
//   for (const s of curSentences) {
//     if (prevSet.has(s)) overlap += 1;
//   }
//   return overlap / curSentences.length;
// }
// function parseBlocksFromContent(content) {
//   const raw = (content || "").trim();
//   const jsonMatch = raw.match(/\s*(\[[\s\S]*\])\s*$/);
// @@ -365,6 +390,11 @@ You must write ONE EPISODE of a short-form / vertical drama script with these ru
// - Avoid graphic violence, gore, or long slapstick brawls. Do NOT ramble or list random objects, professions, or technical details; stay tightly focused on the characters, their feelings, and the immediate scene.
// - End the episode on a clear, clean hook or cliffhanger centred on the heroine (an emotional blow, surprising gesture, or new threat/opportunity that directly affects her).
// CONFLICT AND ESCALATION REQUIREMENTS:
// - Every episode must move at least ONE external stake forward in a concrete way (family approval/disapproval, money or contracts, company/pack politics, social reputation/public humiliation, or a rival’s scheme).
// - Do NOT repeat the same "chase → corner → forced kiss" choreography in adjacent episodes. If a recent episode already used a strong physical-ownership beat, switch to a different form of conflict (verbal confrontation, public scene, business/family move, secret revealed, heroine gaining leverage).
// - Physical closeness scenes (kisses, pinning, grabs) must either be clearly interrupted or have visible consequences, OR clearly increase the heroine’s agency (she sets a boundary, wins leverage, or initiates on her own terms).
// ANTI-REPETITION AND FORMAT (critical — vertical scripts are sparse):
// - Dialogue must dominate: each scene should be mostly character lines, not long prose.
// - Action/stage direction: maximum 1–2 sentences per block. Never write long descriptive paragraphs; break into short beats (e.g. "She turns. He steps closer.").
// @@ -426,10 +456,7 @@ function buildEpisodePromptText({
//   previousEpisodeScripts = [],
// }) {
//   const langTag = String(language || "EN").toUpperCase() === "ZH" ? "ZH" : "EN";
//   const genreTag =
//     String(genre || "NON_WEREWOLF").toUpperCase() === "WEREWOLF"
//       ? "WEREWOLF"
//       : "NON_WEREWOLF";
//   const genreTag = String(genre || "Romance").trim() || "Romance";
//   const total = Math.max(1, totalEpisodes || 1);
//   const ep = Math.max(1, episodeNumber || 1);
//   const cleanLogline = safeStr(logline).slice(0, 1500);
// @@ -469,20 +496,28 @@ function buildEpisodePromptText({
//   }

//   // Dynamic programming / memo: pass the actual script of the previous episode(s)
//   // so the model continues from the exact final line (critical for paid cliffhangers).
//   // so the model continues from the exact final line (critical for paid cliffhangers),
//   // BUT do not allow the model to restage the exact same scene.
//   if (ep > 1 && Array.isArray(previousEpisodeScripts) && previousEpisodeScripts.length > 0) {
//     const toInclude = previousEpisodeScripts.slice(-PREVIOUS_EPISODES_IN_CONTEXT);
//     const label = toInclude.length === 1 ? "PREVIOUS EPISODE" : "PREVIOUS EPISODES";
//     lines.push("");
//     lines.push(
//       `CONTINUATION REQUIREMENT (critical for this format): The audience has just paid to see what happens next. Below is the exact end of the ${label}. You MUST continue the story immediately from the next moment—same scene, same characters, same emotional beat. Do not time-skip, change location, or restart; pick up from the last line or action and continue.`
//     );
//     lines.push(
//       `DO NOT restage the same key moments from the previous episode (no replaying the same kiss, shove, or confrontation). If you need to reference them, compress them into one short recap line, then move the story FORWARD with new events and consequences.`
//     );
//     lines.push("");
//     const TAIL_LINES = 30; // only keep the tail of each previous episode
//     toInclude.forEach((script, i) => {
//       const which = toInclude.length === 1 ? "PREVIOUS EPISODE" : `EPISODE ${ep - toInclude.length + i}`;
//       lines.push(`--- END OF ${which} ---`);
//       lines.push(safeStr(script).trim());
//       lines.push(`--- END OF ${which} ---`);
//       const full = safeStr(script).trim();
//       const split = full.split(/\r?\n/);
//       const tail = split.slice(-TAIL_LINES).join("\n");
//       lines.push(`--- END OF ${which} (tail) ---`);
//       lines.push(tail);
//       lines.push(`--- END OF ${which} (tail) ---`);
//       lines.push("");
//     });
//     lines.push(`Write episode ${ep} now, continuing directly from the text above.`);
// @@ -531,7 +566,7 @@ app.post("/generate", async (req, res) => {
//   const body = req.body || {};
//   const episodeCount = Math.max(1, Math.min(120, parseInt(body.episodeCount, 10) || 60));
//   const logline = safeStr(body.logline).slice(0, 1500);
//   const genre = String(body.genre || "NON_WEREWOLF").toUpperCase() === "WEREWOLF" ? "WEREWOLF" : "NON_WEREWOLF";
//   const genre = String(body.genre || "Romance").trim() || "Romance";
//   const seriesNames = getSeriesNames(genre);

//   res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
// @@ -596,12 +631,44 @@ app.post("/generate", async (req, res) => {
//           presence_penalty: 0.6,
//         });

//         const rawContent = completion.choices?.[0]?.message?.content;
//         const episodeText =
//         let rawContent = completion.choices?.[0]?.message?.content;
//         let episodeText =
//           typeof rawContent === "string" && rawContent.trim()
//             ? rawContent.trim()
//             : `[Episode ${ep} — no content]`;

//         // Phase 2: if this episode is too similar to the previous one, regenerate once with a stronger instruction.
//         if (ep > 1 && episodeScriptsMemo.length > 0) {
//           const prevScript = episodeScriptsMemo[episodeScriptsMemo.length - 1];
//           const score = repetitionScore(episodeText, prevScript);
//           const REPETITION_THRESHOLD = 0.35;
//           if (score > REPETITION_THRESHOLD) {
//             console.warn(
//               `Episode ${ep} repetition score ${score.toFixed(
//                 2
//               )} > ${REPETITION_THRESHOLD}, regenerating with anti-repetition hint.`
//             );
//             const retryContent =
//               userContent +
//               "\n\nREWRITE REQUIREMENT: The previous attempt repeated scenes or sentences from the prior episode. This time you MUST move the story forward with NEW events and consequences. Do not reuse sentences or restage the same physical beats.";
//             const retry = await openai.chat.completions.create({
//               model: FINETUNED_MODEL,
//               messages: [
//                 { role: "system", content: EPISODE_TEXT_SYSTEM_PROMPT },
//                 { role: "user", content: retryContent },
//               ],
//               max_tokens: 2048,
//               temperature: 0.5,
//               frequency_penalty: 1.0,
//               presence_penalty: 0.6,
//             });
//             const retryRaw = retry.choices?.[0]?.message?.content;
//             if (typeof retryRaw === "string" && retryRaw.trim()) {
//               episodeText = retryRaw.trim();
//             }
//           }
//         }
//         // Summarize this episode for future context (best-effort).
//         try {
//           const recap = await summarizeEpisode({
// @@ -643,6 +710,38 @@ app.get("/health", (_, res) => {
//   res.json({ ok: true, model: FINETUNED_MODEL });
// });

// // ---------------------------------------------------------------------------
// // Genre-based summary suggestions (framework: add 100 summaries per genre to data/summaries_by_genre.json)
// // ---------------------------------------------------------------------------
// const SUMMARIES_PATH = join(__dirname, "data", "summaries_by_genre.json");
// function loadSummariesByGenre() {
//   try {
//     const raw = fs.readFileSync(SUMMARIES_PATH, "utf8");
//     const data = JSON.parse(raw);
//     return data && typeof data === "object" ? data : {};
//   } catch (e) {
//     return {};
//   }
// }
// /** GET /summaries?genre=Romance — list all summaries for that genre */
// app.get("/summaries", (req, res) => {
//   const genre = String(req.query.genre || "").trim() || "Romance";
//   const data = loadSummariesByGenre();
//   const summaries = Array.isArray(data[genre]) ? data[genre] : [];
//   res.json({ genre, summaries });
// });
// /** GET /summaries/random?genre=Romance — one random summary for that genre */
// app.get("/summaries/random", (req, res) => {
//   const genre = String(req.query.genre || "").trim() || "Romance";
//   const data = loadSummariesByGenre();
//   const list = Array.isArray(data[genre]) ? data[genre] : [];
//   const summary = list.length > 0 ? list[Math.floor(Math.random() * list.length)] : "";
//   res.json({ genre, summary });
// });
// const PORT = process.env.PORT || 3001;
// app.listen(PORT, () => {
//   console.log(`Server running on http://localhost:${PORT}`);
// ‎frontend/src/App.css‎
// +32
// -1
// Lines changed: 32 additions & 1 deletion
// Original file line number	Diff line number	Diff line change
// @@ -230,7 +230,38 @@
//   display: block;
//   margin-top: 0.25rem;
//   font-size: 0.8rem;
//   color: var(--blood-pale);
// }
// .summary-suggestions {
//   display: flex;
//   flex-wrap: wrap;
//   align-items: center;
//   gap: 0.5rem;
//   margin-top: 0.5rem;
// }
// .summary-hint {
//   font-size: 0.85rem;
//   color: var(--metal);
//   margin: 0 0 0.35rem;
// }
// .summary-suggestions-label {
//   font-size: 0.85rem;
//   color: var(--metal);
//   margin-right: 0.25rem;
// }
// .btn-small {
//   padding: 0.35rem 0.6rem;
//   font-size: 0.85rem;
// }
// .summary-dropdown {
//   flex: 1;
//   min-width: 120px;
//   max-width: 100%;
//   padding: 0.35rem 0.5rem;
//   font-size: 0.85rem;
//   background: var(--steel);
//   color: var(--cream);
//   border: 1px solid var(--steel-light);
//   border-radius: 4px;
// }
// .field textarea.invalid + .word-count {
//   color: #e88;
// ‎frontend/src/App.jsx‎
// +71
// -24
// Lines changed: 71 additions & 24 deletions
// Original file line number	Diff line number	Diff line change
// @@ -6,22 +6,49 @@ const API_BASE = "https://vertical-script.onrender.com";

// function App() {
//   const [modalOpen, setModalOpen] = useState(false);
//   const [genre, setGenre] = useState("NON_WEREWOLF");
//     const PRESET_SUMMARY =
//     "Poor, underestimated heroine, all bad luck lands on her, two handsome rich men competing for her, she's forced to grow, and will eventually marry into money/power.";
//   const [logline, setLogline] = useState(PRESET_SUMMARY);
//   const GENRES = [
//     "Romance",
//     "Drama",
//     "Action",
//     "Adventure",
//     "Crime",
//     "Horror",
//     "Fantasy",
//     "Monster",
//     "Science Fiction",
//     "Superhero",
//     "Werewolf",
//   ];
//   const [genre, setGenre] = useState("");
//   const [logline, setLogline] = useState("");
//   const [loading, setLoading] = useState(false);
//   const [progress, setProgress] = useState({ episode: 0, total: 0 });
//   const [script, setScript] = useState("");
//   const [error, setError] = useState("");
//   const [downloading, setDownloading] = useState(false);
//   const [loadingSuggestions, setLoadingSuggestions] = useState(false);

//   const wordCount = logline.trim() ? logline.trim().split(/\s+/).length : 0;
//   const loglineOverLimit = wordCount > 250;

//   const handleSuggestRandomSummary = async () => {
//     setLoadingSuggestions(true);
//     try {
//       const r = await fetch(`${API_BASE}/summaries/random?genre=${encodeURIComponent(genre)}`);
//       if (r.ok) {
//         const data = await r.json();
//         if (data.summary) setLogline(data.summary);
//       }
//     } catch (_) {}
//     finally {
//       setLoadingSuggestions(false);
//     }
//   };
//   const handleSubmit = async (e) => {
//     e.preventDefault();
//     if (loglineOverLimit) return;
//     if (!genre || loglineOverLimit) return;
//     if (!logline.trim()) return;
//     setError("");
//     setScript("");
//     setProgress({ episode: 0, total: 60 });
// @@ -353,29 +380,49 @@ function App() {
//             )}
//             <form onSubmit={handleSubmit}>
//               <label className="field">
//                 <span>Genre (Normal / Werewolf) / 类型（普通 / 狼人）</span>
//                 <span>Genre / 类型</span>
//                 <select
//                   value={genre}
//                   onChange={(e) => setGenre(e.target.value)}
//                   onChange={(e) => {
//                     setGenre(e.target.value);
//                     if (!e.target.value) setLogline("");
//                   }}
//                 >
//                   <option value="NON_WEREWOLF">Normal / 普通</option>
//                   <option value="WEREWOLF">Werewolf / 狼人</option>
//                   <option value="">— Select a genre —</option>
//                   {GENRES.map((g) => (
//                     <option key={g} value={g}>
//                       {g}
//                     </option>
//                   ))}
//                 </select>
//               </label>
//               <label className="field">
//                 <span>Summary / 摘要</span>
//                 <textarea
//                   value={logline}
//                   onChange={(e) => setLogline(e.target.value)}
//                   placeholder="A short premise or summary for your vertical..."
//                   rows={4}
//                   className={loglineOverLimit ? "invalid" : ""}
//                 />
//                 <small className="word-count">
//                   {wordCount} / 250 words
//                   {loglineOverLimit && " — over limit"}
//                 </small>
//               </label>
//               {genre && (
//                 <label className="field summary-field">
//                   <span>Summary / 摘要</span>
//                   <p className="summary-hint">Write a short premise or generate one for this genre.</p>
//                   <textarea
//                     value={logline}
//                     onChange={(e) => setLogline(e.target.value)}
//                     placeholder="A short premise or summary for your vertical..."
//                     rows={4}
//                     className={loglineOverLimit ? "invalid" : ""}
//                   />
//                   <small className="word-count">
//                     {wordCount} / 250 words
//                     {loglineOverLimit && " — over limit"}
//                   </small>
//                   <div className="summary-suggestions">
//                     <button
//                       type="button"
//                       className="btn btn-secondary btn-small"
//                       onClick={handleSuggestRandomSummary}
//                       disabled={loadingSuggestions}
//                     >
//                       {loadingSuggestions ? "…" : "Generate one"}
//                     </button>
//                   </div>
//                 </label>
//               )}
//               {error && <p className="error">{error}</p>}
//               <div className="modal-actions">
//                 <button
// @@ -389,7 +436,7 @@ function App() {
//                 <button
//                   type="submit"
//                   className="btn btn-primary"
//                   disabled={loading || loglineOverLimit}
//                   disabled={loading || !genre || !logline.trim() || loglineOverLimit}
//                 >
//                   {loading ? (progress.total > 0 ? `Episode ${progress.episode}/${progress.total}` : "Generating…") : "Generate"}
//                 </button>
// ‎parse_genre_scripts.py‎
// +65
// Lines changed: 65 additions & 0 deletions
// Original file line number	Diff line number	Diff line change
// @@ -0,0 +1,65 @@
// #!/usr/bin/env python3
// """
// Phase 1: Parse genre reference scripts (movie/TV) under DataBase/1Genres/.
// - Reads only from DataBase/1Genres/<Genre>/*.pdf.
// - Extracts raw text per PDF (no vertical structure; no blocks/episodes).
// - Writes to DataBase/1Genres_parsed/<Genre>/<script_slug>.txt.
// This output is for later anonymization and reference only. It is never
// fed into global_blocks, train_v2, or any vertical training pipeline.
// """
// from pathlib import Path
// from pypdf import PdfReader
// DATA_DIR = Path("DataBase")
// GENRES_ROOT = DATA_DIR / "1Genres"
// PARSED_ROOT = DATA_DIR / "1Genres_parsed"
// def extract_text_from_pdf(pdf_path: Path) -> str:
//     """Extract raw text from all pages. Returns a single string."""
//     reader = PdfReader(str(pdf_path))
//     parts = []
//     for i, page in enumerate(reader.pages):
//         text = page.extract_text()
//         if text and text.strip():
//             parts.append(text)
//     return "\n\n".join(parts)
// def main():
//     if not GENRES_ROOT.exists():
//         print(f"Genre root not found: {GENRES_ROOT}")
//         return
//     parsed_count = 0
//     for genre_dir in sorted(GENRES_ROOT.iterdir()):
//         if not genre_dir.is_dir():
//             continue
//         genre_name = genre_dir.name
//         out_genre_dir = PARSED_ROOT / genre_name
//         out_genre_dir.mkdir(parents=True, exist_ok=True)
//         for pdf_path in sorted(genre_dir.glob("*.pdf")):
//             slug = pdf_path.stem
//             out_path = out_genre_dir / f"{slug}.txt"
//             try:
//                 text = extract_text_from_pdf(pdf_path)
//                 if not text.strip():
//                     print(f"  [skip] {genre_name}/{pdf_path.name}: no text extracted")
//                     continue
//                 out_path.write_text(text, encoding="utf-8", errors="replace")
//                 parsed_count += 1
//                 print(f"  {genre_name}/{pdf_path.name} -> 1Genres_parsed/{genre_name}/{slug}.txt")
//             except Exception as e:
//                 print(f"  [error] {genre_name}/{pdf_path.name}: {e}")
//     print(f"\nDone. Parsed {parsed_count} scripts into {PARSED_ROOT}")
// if __name__ == "__main__":
//     main()
// ‎run_openai_finetune.py‎
// +55
// -27
// Lines changed: 55 additions & 27 deletions
// Original file line number	Diff line number	Diff line change
// @@ -37,8 +37,11 @@

// TRAIN_JSONL = Path("train_v2.jsonl")
// OPENAI_TRAIN_JSONL = Path("train_openai_v2.jsonl")
// TRAIN_GENRE_JSONL = Path("train_v2_genre_tagged.jsonl")
// OPENAI_GENRE_JSONL = Path("train_openai_genre_tagged.jsonl")
// MODEL = "gpt-4o-mini"
// SUFFIX = "vertical-script"  # your fine-tuned model will be named like gpt-4o-mini:ft:::vertical-script:xxxx
// SUFFIX_GENRE = "vertical-genre"  # second model: genre-conditioned

// SYSTEM_PROMPT = """You are a vertical episode writer for short-form / vertical dramas.
// @@ -62,17 +65,26 @@
// Do NOT include any extra commentary or metadata outside the JSON array of blocks.
// """

// SYSTEM_PROMPT_GENRE = SYSTEM_PROMPT + """
// def convert_to_openai_format():
//     """Convert train_v2.jsonl (structured input/output) to OpenAI messages format."""
//     if not TRAIN_JSONL.exists():
//         print(f"Run build_train_v2_jsonl.py first to create {TRAIN_JSONL}", file=sys.stderr)
// The input may include genre_tag (e.g. Horror, Superhero, Adventure) and setting_hint. Use them to flavor tone, setting, and vocabulary while keeping the same vertical format, dialogue-led structure, and hooks. Output is always a JSON array of blocks.
// """
// def convert_to_openai_format(genre_tagged: bool = False):
//     """Convert train_v2.jsonl or train_v2_genre_tagged.jsonl to OpenAI messages format.
//     Output file has one JSON object per line with key 'messages' (required by OpenAI).
//     Do NOT upload the raw *train_v2*.jsonl file; upload the converted *train_openai*.jsonl file.
//     """
//     src = TRAIN_GENRE_JSONL if genre_tagged else TRAIN_JSONL
//     out = OPENAI_GENRE_JSONL if genre_tagged else OPENAI_TRAIN_JSONL
//     system = SYSTEM_PROMPT_GENRE if genre_tagged else SYSTEM_PROMPT
//     if not src.exists():
//         print(f"Create {src} first: run build_train_v2_genre_tagged.py" if genre_tagged else f"Run build_train_v2_jsonl.py first to create {src}", file=sys.stderr)
//         sys.exit(1)

//     count = 0
//     with TRAIN_JSONL.open("r", encoding="utf-8") as f_in, OPENAI_TRAIN_JSONL.open(
//         "w", encoding="utf-8"
//     ) as f_out:
//     with src.open("r", encoding="utf-8") as f_in, out.open("w", encoding="utf-8") as f_out:
//         for line in f_in:
//             line = line.strip()
//             if not line:
// @@ -87,32 +99,43 @@ def convert_to_openai_format():
//             if not ep_input or not ep_output:
//                 continue

//             # Serialize structured input/output as JSON strings for the chat API
//             user_content = json.dumps(ep_input, ensure_ascii=False)
//             assistant_content = json.dumps(ep_output, ensure_ascii=False)

//             messages = [
//                 {"role": "system", "content": SYSTEM_PROMPT},
//                 {"role": "system", "content": system},
//                 {"role": "user", "content": user_content},
//                 {"role": "assistant", "content": assistant_content},
//             ]
//             f_out.write(json.dumps({"messages": messages}, ensure_ascii=False) + "\n")
//             openai_record = {"messages": messages}
//             f_out.write(json.dumps(openai_record, ensure_ascii=False) + "\n")
//             count += 1

//     print(f"Converted {count} examples to {OPENAI_TRAIN_JSONL}")
//     if count == 0:
//         print("No valid records converted.", file=sys.stderr)
//         sys.exit(1)
//     # Validate first line has "messages"
//     with out.open("r", encoding="utf-8") as f:
//         first = json.loads(f.readline())
//     if "messages" not in first:
//         print("Validation failed: first line missing 'messages' key.", file=sys.stderr)
//         sys.exit(1)
//     print(f"Converted {count} examples to {out}")
//     print(f"  -> Upload {out.name} to OpenAI (NOT {src.name})")
//     return count


// def upload_and_finetune():
//     """Upload train_openai.jsonl and create fine-tuning job."""
//     if not OPENAI_TRAIN_JSONL.exists():
//         convert_to_openai_format()
// def upload_and_finetune(genre_tagged: bool = False):
//     """Upload train_openai*.jsonl and create fine-tuning job."""
//     out = OPENAI_GENRE_JSONL if genre_tagged else OPENAI_TRAIN_JSONL
//     if not out.exists():
//         convert_to_openai_format(genre_tagged=genre_tagged)

//     print("Uploading training file to OpenAI...")
//     print(f"Uploading {out} to OpenAI...")
//     file_id = None
//     for attempt in range(3):
//         try:
//             with OPENAI_TRAIN_JSONL.open("rb") as f:
//             with out.open("rb") as f:
//                 file_response = client.files.create(file=f, purpose="fine-tune")
//             file_id = file_response.id
//             break
// @@ -136,11 +159,12 @@ def upload_and_finetune():
//         raise RuntimeError("Upload failed after retries")
//     print(f"Uploaded file_id: {file_id}")

//     print("Creating fine-tuning job (this may take a while)...")
//     suffix = SUFFIX_GENRE if genre_tagged else SUFFIX
//     print(f"Creating fine-tuning job (suffix={suffix}, this may take a while)...")
//     job = client.fine_tuning.jobs.create(
//         training_file=file_id,
//         model=MODEL,
//         suffix=SUFFIX,
//         suffix=suffix,
//         hyperparameters={"n_epochs": 2},
//     )

// @@ -151,13 +175,14 @@ def upload_and_finetune():
//     return job.id


// def create_job_with_file_id(file_id: str):
//     """Call after uploading train_openai.jsonl manually; pass the file ID from the UI."""
//     print("Creating fine-tuning job...")
// def create_job_with_file_id(file_id: str, genre_tagged: bool = False):
//     """Call after uploading train_openai*.jsonl manually; pass the file ID from the UI."""
//     suffix = SUFFIX_GENRE if genre_tagged else SUFFIX
//     print(f"Creating fine-tuning job (suffix={suffix})...")
//     job = client.fine_tuning.jobs.create(
//         training_file=file_id,
//         model=MODEL,
//         suffix=SUFFIX,
//         suffix=suffix,
//         hyperparameters={"n_epochs": 2},
//     )
//     print(f"Job created: {job.id} | Status: {job.status}")
// @@ -169,13 +194,16 @@ def create_job_with_file_id(file_id: str):
//     import argparse
//     parser = argparse.ArgumentParser(description="Build OpenAI fine-tune data and/or start job")
//     parser.add_argument("--file-id", type=str, help="Use this file ID (from manual upload) to create job only")
//     parser.add_argument("--convert-only", action="store_true", help="Only convert train_v2.jsonl to OpenAI format and exit")
//     parser.add_argument("--convert-only", action="store_true", help="Only convert to OpenAI format and exit")
//     parser.add_argument("--genre-tagged", action="store_true", help="Use train_v2_genre_tagged.jsonl for genre-conditioned model (second model)")
//     args = parser.parse_args()

//     convert_to_openai_format()
//     convert_to_openai_format(genre_tagged=args.genre_tagged)
//     if args.convert_only:
//         out_name = OPENAI_GENRE_JSONL.name if args.genre_tagged else OPENAI_TRAIN_JSONL.name
//         print(f"Done. Upload {out_name} at https://platform.openai.com/fine-tuning then run with --file-id <id>" + (" --genre-tagged" if args.genre_tagged else ""))
//         sys.exit(0)
//     if args.file_id:
//         create_job_with_file_id(args.file_id)
//         create_job_with_file_id(args.file_id, genre_tagged=args.genre_tagged)
//     else:
//         upload_and_finetune()
//         upload_and_finetune(genre_tagged=args.genre_tagged)