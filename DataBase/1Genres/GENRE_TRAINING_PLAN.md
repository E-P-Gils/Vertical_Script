# Genre Scripts: Parse, Training, and Safeguards Plan

## Goals
1. **Parse** movie/TV scripts in `1Genres/<Genre>/` for use as genre reference.
2. **Use them to expand generation** (genre flavor) without changing vertical format.
3. **Safeguards:** Generated structure comes ONLY from the 30 vertical scripts + prompt engineering. Character names, specific environments, and situations from genre scripts must NOT be reproduced.

---

## Principle: Structure vs. Flavor

| Source | Used for | Never used for |
|--------|----------|----------------|
| **30 vertical scripts** | Output structure, episode length, hooks, 3-7-21, love/lust/sex focus, dialogue-led style | — |
| **1Genres movie/TV scripts** | Generic setting types, tone, vocabulary (anonymized) | Output structure; character names; specific places/plots |

---

## Phase 1: Parse Genre Scripts (Separate Pipeline)

- **Input:** PDFs under `DataBase/1Genres/<Genre>/*.pdf` (e.g. Superhero, Horror, Adventure).
- **Output:** Store **raw extracted text only** (no blocks/episodes in vertical format). Options:
  - `DataBase/1Genres_parsed/<genre>/<script_slug>.txt` — one text file per script, or
  - `DataBase/1Genres_parsed/<genre>/<script_slug>.json` — structured chunks (e.g. scene heading + dialogue + action) for later anonymization.
- **Tool:** New script `parse_genre_scripts.py` that:
  - Iterates only over `DataBase/1Genres/**/*.pdf`.
  - Extracts text (e.g. with pypdf) and optionally detects scene headings / character lines for chunking.
  - Writes to `1Genres_parsed/` (or similar). **Does not write to** `global_blocks`, `global_scenes`, or any vertical training inputs.
- **Exclusion:** Ensure `build_global_files.py`, `clean_blocks_v2.py`, `validate_episodes_v2.py`, `tag_scenes_v2.py`, and `build_train_v2_jsonl.py` **exclude** `DataBase/1Genres` (and `1Genres_parsed`) so genre content never enters vertical training inputs.

---

## Phase 2: Anonymize Genre Content

- **Input:** Parsed genre text (per script or per chunk).
- **Process:**
  - Replace **character names** with generic tags: e.g. `[HERO]`, `[VILLAIN]`, `[LOVE_INTEREST]`, `[SIDEKICK]`, `[AUTHORITY]`.
  - Replace **specific locations** with generic: `[THE CITY]`, `[HEADQUARTERS]`, `[THE SHIP]`, `[THE CASTLE]`, etc.
  - Replace **distinctive plot details** (e.g. "Kryptonite", "Gotham") with generic equivalents or remove.
  - Produce **short reference snippets** (e.g. 200–800 tokens) per genre: tone, setting type, vocabulary (power words, atmosphere), without any proper nouns or IP.
- **Output:** `DataBase/1Genres_reference/<genre>/snippets.json` or `reference_<genre>.txt` — anonymized, generic “what this genre feels like” text.
- **Blocklist:** Build a list of **forbidden strings** from genre scripts (character names, places, famous lines). Used at inference or post-process to flag/mask if model output contains them.

---

## Phase 3: Training Data (No Genre Script Structure or IP) — IMPLEMENTED

- **Vertical training data (existing):** `train_v2.jsonl` (and eval) is built **only** from:
  - `global_blocks_clean.jsonl` / `global_scenes_tagged_v2.jsonl` / `episodes_validated_v2.jsonl`
  - which in turn are built **only** from vertical shows (exclude `1Genres` and `1Genres_parsed`).
- **Safeguard:** `build_train_v2_jsonl.py` skips any `show_id` in `EXCLUDED_SHOW_IDS` (genre folder names, 1Genres*).
- **Option B implemented:** Run `python build_train_v2_genre_tagged.py` to get `train_v2_genre_tagged.jsonl` / `eval_v2_genre_tagged.jsonl` (input has `genre_tag` + `setting_hint`; output is same vertical blocks).
- **New round of training options:**
  - **Option A (recommended):** Do **not** put genre script text (even anonymized) into training. Keep training 100% vertical-structure. At **inference**, inject anonymized genre reference into the prompt so the model gets “flavor” only at generation time. No risk of structure or name leakage.
  - **Option B:** Add training examples where **input** includes `[GENRE=SUPERHERO]` (etc.) + short anonymized “setting type” description, and **output** is still a **vertical-format episode from the existing vertical corpus** (same structure). So the model learns “when GENRE=X, still output vertical format.” Genre scripts never appear as target output; only genre tags (and optionally generic one-line setting hints) appear in input.
- **Rule:** Genre script text, whether raw or anonymized, must **never** appear as training **output**. Output is always vertical-format from the 30 vertical shows (or synthetic vertical with generic names only).

---

## Phase 4: Safeguards

1. **Pipeline exclusion**
   - In `build_global_files.py` (and any script that reads `DataBase` for vertical data): skip directories named `1Genres`, `1Genres_parsed`, `1Genres_reference`.
   - Ensures genre PDFs/text never feed into `global_blocks`, `train_v2.jsonl`, etc.

2. **Blocklist (runtime or post-process)**
   - Maintain `DataBase/1Genres_blocklist.txt` (or .json): character names, locations, and distinctive phrases extracted from genre scripts.
   - After generation (or in the backend before returning): check model output against blocklist; if match, optionally mask/replace with generic term or flag for review. Ensures names/places from genre scripts are not reproduced.

3. **Inference-time genre reference**
   - When user selects a genre, only **anonymized** reference (from Phase 2) is added to the prompt. No raw genre script lines. Prompts continue to enforce vertical format (hooks, 3-7-21, dialogue-led, etc.) so structure always comes from training + prompt engineering.

---

## Implementation Order

1. **Exclude 1Genres from vertical pipeline** (build_global_files, build_train_v2_jsonl inputs, etc.).
2. **Parse genre scripts** → `parse_genre_scripts.py` → output to `1Genres_parsed/`.
3. **Anonymize** → script that reads parsed genre text, produces anonymized snippets + blocklist → `1Genres_reference/`, `1Genres_blocklist.txt`.
4. **Training:** Either keep current train_v2 as-is and use genre only at inference (Option A), or add genre-tagged input examples with vertical output only (Option B).
5. **Backend:** When user picks genre, inject anonymized genre reference into prompt; optionally run blocklist check on generated text.

---

## Summary

- **Structure:** Always from 30 vertical scripts + prompts. Genre scripts never define output structure.
- **Flavor:** Generic concepts, worlds, environments from anonymized genre reference only; no character names, specific places, or plot points from genre scripts in training or in allowed model output.
- **Safeguards:** Pipeline exclusion, anonymization, blocklist, and inference-time-only genre reference keep IP and structure safe.
