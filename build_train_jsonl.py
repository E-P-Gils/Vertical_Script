#!/usr/bin/env python3
"""
Build train.jsonl for vertical-script generator fine-tuning.

Each record is:
{
  "input": "<control header and instructions>",
  "output": "<full script text in vertical format>"
}

Control header encodes:
- language (EN / ZH)
- genre (WEREWOLF / NON_WEREWOLF)
- episode count
- title

This is provider-agnostic; you'll map "input"/"output" to your
fine-tuning schema (e.g. prompt/completion) as needed.
"""

import json
from pathlib import Path


DATA_DIR = Path("DataBase")
TRAIN_PATH = Path("train.jsonl")

# Manually tagged werewolf shows based on content/keywords
WEREWOLF_SHOWS = {
    "katherine_heres_your_husband",
    "chasing_my_unwanted_mate",
    "fated_to_my_bad_boy_alpha",
    "rejected_slave_meets_her_alpha",
    "chinese_werewolf",  # when populated
}


def iter_show_dirs():
    if not DATA_DIR.exists():
        return
    for d in sorted(DATA_DIR.iterdir()):
        if d.is_dir():
            yield d


def detect_language(blocks_path: Path, max_lines: int = 200) -> str:
    """
    Heuristic: if a significant fraction of non-whitespace characters
    are non-ASCII, treat as ZH; otherwise EN.
    """
    ascii_count = 0
    non_ascii_count = 0

    try:
        with blocks_path.open("r", encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i >= max_lines:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                text = rec.get("text", "")
                for ch in text:
                    if ch.isspace():
                        continue
                    if ord(ch) < 128:
                        ascii_count += 1
                    else:
                        non_ascii_count += 1
    except FileNotFoundError:
        return "EN"

    total = ascii_count + non_ascii_count
    if total == 0:
        return "EN"
    ratio = non_ascii_count / total
    return "ZH" if ratio > 0.3 else "EN"


def build_script_text(blocks_path: Path) -> str:
    """
    Reconstruct a vertical-style script string from blocks.jsonl:
    - scene headings as-is
    - dialogue as CHARACTER (+ optional parenthetical) then text
    - action/transition as text
    """
    blocks = []
    with blocks_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            blocks.append(rec)

    def sort_key(b):
        return (
            b.get("episode_number", 0) or 0,
            b.get("scene_number", 0) or 0,
            b.get("block_index", 0) or 0,
        )

    blocks.sort(key=sort_key)

    lines = []
    for b in blocks:
        btype = b.get("block_type", "")
        text = (b.get("text") or "").strip()
        if not text:
            continue

        if btype == "scene_heading":
            lines.append(text)
        elif btype == "dialogue":
            char = (b.get("character") or "").strip()
            paren = (b.get("parenthetical") or "") or None
            if char:
                if paren:
                    lines.append(f"{char} ({paren})")
                else:
                    lines.append(char)
            lines.append(text)
        elif btype == "transition":
            lines.append(text)
        else:
            # action or other narrative
            lines.append(text)

    return "\n".join(lines).strip()


def build_train():
    if TRAIN_PATH.exists():
        TRAIN_PATH.unlink()

    with TRAIN_PATH.open("w", encoding="utf-8") as out_f:
        for show_dir in iter_show_dirs():
            show_id = show_dir.name
            show_json_path = show_dir / "show.json"
            blocks_path = show_dir / "blocks.jsonl"

            if not blocks_path.exists() or not show_json_path.exists():
                continue

            try:
                show_meta = json.loads(show_json_path.read_text(encoding="utf-8"))
            except Exception:
                show_meta = {}

            title = show_meta.get("title") or show_id
            total_episodes = show_meta.get("total_episodes")

            # Genre
            genre = "WEREWOLF" if show_id in WEREWOLF_SHOWS else "NON_WEREWOLF"

            # Language heuristic
            lang = detect_language(blocks_path).upper()

            # Build script text
            script_text = build_script_text(blocks_path)
            if not script_text:
                continue

            # Episode count fallback: count lines in episodes.jsonl if needed
            if total_episodes is None:
                episodes_path = show_dir / "episodes.jsonl"
                if episodes_path.exists():
                    with episodes_path.open("r", encoding="utf-8") as ef:
                        total_episodes = sum(1 for _ in ef)
                else:
                    total_episodes = 0

            # Control header
            header_lines = [
                f"[LANG={lang}] [GENRE={genre}] [EPISODES={total_episodes}]",
                f"[TITLE] {title}",
                "[LOGLINE] ",  # left blank; user can supply at inference time
                "[START_SCRIPT]",
            ]
            control = "\n".join(header_lines)

            record = {
                "input": control,
                "output": script_text,
            }
            out_f.write(json.dumps(record, ensure_ascii=False) + "\n")


def main():
    build_train()
    print(f"Wrote {TRAIN_PATH}")


if __name__ == "__main__":
    main()

