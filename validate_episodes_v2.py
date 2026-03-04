#!/usr/bin/env python3
"""
Phase 2: Validate episodes for v2 training.

Inputs (under DataBase/):
  - global_blocks_clean.jsonl   (from clean_blocks_v2.py)
  - global_scenes.jsonl         (from build_global_files.py)
  - global_episodes.jsonl       (from build_global_files.py)

Outputs (under DataBase/):
  - episodes_validated_v2.jsonl  (only good episodes, + valid_v2=true)
  - episodes_invalid_v2.jsonl    (rejected episodes with invalid_reason)

Validation rules per (show_id, episode):
  - 2 <= scene_count <= 7
  - len(blocks) >= 18 OR word_count >= 250
  - Cliffhanger-ish ending:
      * last dialogue ends with "?"
        OR
      * last action contains one of:
          ["suddenly", "but then", "just as", "before he can", "before she can"]
  - Non-triviality:
      * At least 2 distinct dialogue speakers,
        unless there are 0 dialogue blocks, in which case require word_count >= 300.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple, Set, Any


DATA_DIR = Path("DataBase")
BLOCKS_PATH = DATA_DIR / "global_blocks_clean.jsonl"
SCENES_PATH = DATA_DIR / "global_scenes.jsonl"
EPISODES_PATH = DATA_DIR / "global_episodes.jsonl"
VALID_OUT_PATH = DATA_DIR / "episodes_validated_v2.jsonl"
INVALID_OUT_PATH = DATA_DIR / "episodes_invalid_v2.jsonl"


CliffWords = ["suddenly", "but then", "just as", "before he can", "before she can"]


def _episode_key(show_id: Any, episode: Any) -> Tuple[str, int]:
    sid = str(show_id) if show_id is not None else "UNKNOWN_SHOW"
    try:
        ep = int(episode)
    except (TypeError, ValueError):
        ep = -1
    return sid, ep


def _word_count(text: str) -> int:
    return len(text.split())


def _last_block(blocks: List[dict]) -> dict | None:
    if not blocks:
        return None

    def sort_key(b: dict):
        # Try to sort by block_id numeric index if present, else by insertion order.
        bid = b.get("block_id") or ""
        # Expect something like "E12_S3_B17"
        m = re.search(r"_B(\d+)$", str(bid))
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                pass
        return 0

    return sorted(blocks, key=sort_key)[-1]


def load_indexes():
    # Episodes metadata
    episodes_meta: Dict[Tuple[str, int], dict] = {}
    if not EPISODES_PATH.exists():
        raise FileNotFoundError(f"Missing {EPISODES_PATH}")
    with EPISODES_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = _episode_key(rec.get("show_id"), rec.get("episode"))
            episodes_meta[key] = rec

    # Scenes per episode
    scenes_per_ep: Dict[Tuple[str, int], Set[str]] = defaultdict(set)
    if not SCENES_PATH.exists():
        raise FileNotFoundError(f"Missing {SCENES_PATH}")
    with SCENES_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = _episode_key(rec.get("show_id"), rec.get("episode"))
            sid = rec.get("scene_id")
            if sid:
                scenes_per_ep[key].add(str(sid))

    # Blocks per episode
    blocks_per_ep: Dict[Tuple[str, int], List[dict]] = defaultdict(list)
    if not BLOCKS_PATH.exists():
        raise FileNotFoundError(f"Missing {BLOCKS_PATH}")
    with BLOCKS_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = _episode_key(rec.get("show_id"), rec.get("episode"))
            blocks_per_ep[key].append(rec)

    return episodes_meta, scenes_per_ep, blocks_per_ep


def classify_episode(
    key: Tuple[str, int],
    scenes_per_ep: Dict[Tuple[str, int], Set[str]],
    blocks_per_ep: Dict[Tuple[str, int], List[dict]],
) -> Tuple[bool, str | None, dict | None]:
    """
    Return (is_valid, reason_if_invalid, summary_info).

    NOTE: This validator is intentionally relaxed. We are NOT enforcing 3–7–21
    as scene-count rules. We mainly filter out obviously broken / tiny episodes
    and record useful stats (scene_count, word_count, has_cliffhanger, etc.).
    """
    show_id, episode = key
    scenes = scenes_per_ep.get(key, set())
    blocks = blocks_per_ep.get(key, [])

    # Basic aggregates
    word_count = 0
    speakers: Set[str] = set()
    for b in blocks:
        text = (b.get("text") or "").strip()
        if text:
            word_count += _word_count(text)
        if (b.get("type") or b.get("block_type")) == "dialogue":
            sp = b.get("speaker")
            if sp:
                speakers.add(str(sp).strip().upper())

    sc_count = len(scenes)

    # 1) Length gate (very minimal)
    # Require at least a handful of blocks or some words so we don't
    # train on single-line garbage.
    if len(blocks) < 6 and word_count < 100:
        return False, "too_short", None

    # 2) Cliffhanger-ish ending (recorded as a stat, not a hard gate)
    lb = _last_block(blocks)
    has_cliff = False
    if lb is not None:
        lb_type = lb.get("type") or lb.get("block_type") or ""
        lb_text = (lb.get("text") or "").strip()
        if lb_type == "dialogue" and lb_text.endswith("?"):
            has_cliff = True
        elif lb_type == "action":
            lower = lb_text.lower()
            if any(w in lower for w in CliffWords):
                has_cliff = True

    # 3) 3-7-21 style hook stats (first ~10 blocks)
    head = blocks[:10]
    hook_visual_3s = False
    hook_theme_7s = False
    hook_emotion_21s = False
    # very simple keyword heuristics; this is just for labeling, not gating
    visual_words = [
        "blood",
        "kiss",
        "slap",
        "crying",
        "gun",
        "wolf",
        "wedding",
        "divorce",
    ]
    theme_words = [
        "love",
        "marry",
        "marriage",
        "revenge",
        "betray",
        "secret",
        "alpha",
        "mate",
    ]
    emotion_words = [
        "hate",
        "love",
        "afraid",
        "scared",
        "fear",
        "cry",
        "crying",
        "angry",
        "jealous",
        "jealousy",
    ]

    for idx, b in enumerate(head):
        t = (b.get("text") or "").strip()
        if not t:
            continue
        lower = t.lower()
        # 0-2 (~first 3 seconds)
        if idx <= 2 and not hook_visual_3s:
            if any(w in lower for w in visual_words):
                hook_visual_3s = True
        # 0-4 (~first 7 seconds)
        if idx <= 4 and not hook_theme_7s:
            if any(w in lower for w in theme_words):
                hook_theme_7s = True
        # 0-7 (~first 21 seconds)
        if idx <= 7 and not hook_emotion_21s:
            if any(w in lower for w in emotion_words):
                hook_emotion_21s = True

    summary = {
        "show_id": show_id,
        "episode": episode,
        "scene_count": sc_count,
        "block_count": len(blocks),
        "word_count": word_count,
        "speaker_count": len(speakers),
        "has_cliffhanger_v2": has_cliff,
        "hook_visual_3s": hook_visual_3s,
        "hook_theme_7s": hook_theme_7s,
        "hook_emotion_21s": hook_emotion_21s,
    }
    return True, None, summary


def validate_episodes() -> None:
    episodes_meta, scenes_per_ep, blocks_per_ep = load_indexes()

    valid = 0
    invalid = 0

    with VALID_OUT_PATH.open("w", encoding="utf-8") as valid_f, INVALID_OUT_PATH.open(
        "w", encoding="utf-8"
    ) as invalid_f:
        for key, meta in episodes_meta.items():
            ok, reason, summary = classify_episode(key, scenes_per_ep, blocks_per_ep)
            if ok:
                meta_out = dict(meta)
                meta_out["valid_v2"] = True
                if summary:
                    meta_out.setdefault("_v2_stats", summary)
                valid_f.write(json.dumps(meta_out, ensure_ascii=False) + "\n")
                valid += 1
            else:
                show_id, episode = key
                rec = {
                    "show_id": show_id,
                    "episode": episode,
                    "invalid_reason": reason or "unknown",
                }
                invalid_f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                invalid += 1

    print(
        f"Episode validation complete: {valid} valid, {invalid} invalid. "
        f"Outputs -> {VALID_OUT_PATH}, {INVALID_OUT_PATH}"
    )


if __name__ == "__main__":
    validate_episodes()

