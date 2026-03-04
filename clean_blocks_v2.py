#!/usr/bin/env python3
"""
Phase 1: Hard clean global blocks into a v2 corpus.

Input:
  DataBase/global_blocks.jsonl  (built by build_global_files.py)

Output:
  DataBase/global_blocks_clean.jsonl

Cleaning steps per block:
  - Drop/convert obvious garbage speakers.
  - Drop page-number / numeric-only artifacts.
  - Deduplicate exact duplicate text within a (show_id, episode).

We preserve all existing fields on kept records.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, Set, Tuple


DATA_DIR = Path("DataBase")
INPUT_PATH = DATA_DIR / "global_blocks.jsonl"
OUTPUT_PATH = DATA_DIR / "global_blocks_clean.jsonl"


_SPEAKER_SCENE_RE = re.compile(r"^\d+-\d+[A-Z]?$")
_JUST_NUMBER_RE = re.compile(r"^\s*\d+\s*\.?\s*$")


def _looks_like_prose(text: str, min_words: int = 5) -> bool:
    words = text.strip().split()
    return len(words) >= min_words


def _is_numeric_trash(text: str) -> bool:
    """Heuristic for page markers and numeric-only junk."""
    t = text.strip()
    if not t:
        return True
    if _JUST_NUMBER_RE.match(t):
        return True

    tokens = t.split()
    if len(tokens) < 3 and all(re.fullmatch(r"[\d\W]+", tok) for tok in tokens):
        return True
    return False


def _is_garbage_speaker(speaker: str) -> bool:
    s = speaker.strip()
    upper = s.upper()

    if any(key in upper for key in ("INT.", "EXT.", "FLASHBACK", "BACK TO", "CUT TO")):
        return True
    if _SPEAKER_SCENE_RE.match(upper):
        return True
    # Ends with ":" and is not a simple alphabetic name
    if s.endswith(":") and not re.fullmatch(r"[A-Z][A-Z0-9\s'-]*", upper.rstrip(":")):
        return True
    return False


def clean_blocks() -> None:
    if not INPUT_PATH.exists():
        raise FileNotFoundError(f"Input not found: {INPUT_PATH}")

    seen_texts: Dict[Tuple[str, int], Set[str]] = {}
    kept = 0
    dropped = 0

    with INPUT_PATH.open("r", encoding="utf-8") as inp, OUTPUT_PATH.open(
        "w", encoding="utf-8"
    ) as out_f:
        for line in inp:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                dropped += 1
                continue

            text = (rec.get("text") or "").strip()
            if not text:
                dropped += 1
                continue

            # Drop numeric/page-marker noise
            if _is_numeric_trash(text):
                dropped += 1
                continue

            # Speaker cleanup for dialogue blocks
            block_type = rec.get("type") or rec.get("block_type")
            speaker = rec.get("speaker")
            if block_type == "dialogue" and speaker:
                if _is_garbage_speaker(str(speaker)):
                    if _looks_like_prose(text):
                        # Convert to action block and remove speaker
                        rec["type"] = "action"
                        rec.pop("speaker", None)
                    else:
                        dropped += 1
                        continue

            # Deduplicate exact same text within (show_id, episode)
            show_id = rec.get("show_id") or "UNKNOWN_SHOW"
            episode = rec.get("episode")
            try:
                ep_key = int(episode) if episode is not None else -1
            except (TypeError, ValueError):
                ep_key = -1

            key = (str(show_id), ep_key)
            norm_text = text.lower()
            bucket = seen_texts.setdefault(key, set())
            if norm_text in bucket:
                dropped += 1
                continue
            bucket.add(norm_text)

            # Write cleaned record as-is (preserve all fields)
            out_f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            kept += 1

    print(
        f"Cleaned blocks: kept {kept:,} records, dropped {dropped:,}. "
        f"Output -> {OUTPUT_PATH}"
    )


if __name__ == "__main__":
    clean_blocks()

