#!/usr/bin/env python3
"""
Phase 4: Build structured train/eval JSONL for vertical v2.

Inputs (under DataBase/):
  - global_blocks_clean.jsonl      (from clean_blocks_v2.py)
  - global_scenes_tagged_v2.jsonl  (from tag_scenes_v2.py)
  - episodes_validated_v2.jsonl    (from validate_episodes_v2.py)

Outputs (repo root):
  - train_v2.jsonl
  - eval_v2.jsonl

Each record is:
{
  "input": {
    "show_id": "...",
    "episode": 12,
    "total_episodes_for_show": 60,
    "arc_phase": "lock_in",
    "cliffhanger_flag": true,
    "scenes": [
      {
        "scene_id": "E12_S1",
        "location": "INT. OFFICE - DAY",
        "beat_type": "strategy_planning",
        "arc_phase": "lock_in",
        "characters": [...]
      },
      ...
    ]
  },
  "output": [
    { "block_id": "...", "scene_id": "...", "episode": 12, "type": "action", "speaker": null, "text": "..." },
    ...
  ]
}

We split by show_id to avoid leakage: ~80% of shows for train, 20% for eval.
"""

from __future__ import annotations

import json
import random
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Tuple


DATA_DIR = Path("DataBase")
BLOCKS_PATH = DATA_DIR / "global_blocks_clean.jsonl"
SCENES_PATH = DATA_DIR / "global_scenes_tagged_v2.jsonl"
EPISODES_VALID_PATH = DATA_DIR / "episodes_validated_v2.jsonl"
SHOW_META_PATH = DATA_DIR / "show_metadata_v2.json"

TRAIN_OUT = Path("train_v2.jsonl")
EVAL_OUT = Path("eval_v2.jsonl")


def _episode_key(show_id: Any, episode: Any) -> Tuple[str, int]:
    sid = str(show_id) if show_id is not None else "UNKNOWN_SHOW"
    try:
        ep = int(episode)
    except (TypeError, ValueError):
        ep = -1
    return sid, ep


def _sort_blocks(blocks: List[dict]) -> List[dict]:
    def sort_key(b: dict):
        bid = b.get("block_id") or ""
        m = re.search(r"_B(\d+)$", str(bid))
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                pass
        return 0

    return sorted(blocks, key=sort_key)


def load_valid_episodes():
    """Load validated episode metadata and compute per-show episode lists."""
    if not EPISODES_VALID_PATH.exists():
        raise FileNotFoundError(f"Missing {EPISODES_VALID_PATH}")

    episodes_meta: Dict[Tuple[str, int], dict] = {}
    episodes_by_show: Dict[str, List[int]] = defaultdict(list)

    with EPISODES_VALID_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = _episode_key(rec.get("show_id"), rec.get("episode"))
            show_id, ep = key
            episodes_meta[key] = rec
            if ep >= 0:
                episodes_by_show[show_id].append(ep)

    # Sort episode lists
    for sid in episodes_by_show:
        episodes_by_show[sid] = sorted(set(episodes_by_show[sid]))

    return episodes_meta, episodes_by_show


def load_scenes():
    """Group tagged scenes by (show_id, episode)."""
    if not SCENES_PATH.exists():
        raise FileNotFoundError(f"Missing {SCENES_PATH}")

    scenes_per_ep: Dict[Tuple[str, int], List[dict]] = defaultdict(list)
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
            scenes_per_ep[key].append(rec)
    return scenes_per_ep


def load_blocks():
    """Group cleaned blocks by (show_id, episode)."""
    if not BLOCKS_PATH.exists():
        raise FileNotFoundError(f"Missing {BLOCKS_PATH}")

    blocks_per_ep: Dict[Tuple[str, int], List[dict]] = defaultdict(list)
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

    # Sort blocks within each episode
    for key, blks in list(blocks_per_ep.items()):
        blocks_per_ep[key] = _sort_blocks(blks)

    return blocks_per_ep


def load_show_metadata() -> Dict[str, Dict[str, Any]]:
    """
    Load per-show metadata for protagonist_type, core_theme, content_rating.
    Falls back to sane defaults when missing.
    """
    if not SHOW_META_PATH.exists():
        return {}
    try:
        with SHOW_META_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}

    # Allow a global "_default" entry
    meta: Dict[str, Dict[str, Any]] = {}
    for k, v in data.items():
        if not isinstance(v, dict):
            continue
        meta[str(k)] = v
    return meta


def build_examples():
    episodes_meta, episodes_by_show = load_valid_episodes()
    scenes_per_ep = load_scenes()
    blocks_per_ep = load_blocks()
    show_meta = load_show_metadata()

    # Determine train/eval split by show_id (80/20)
    all_shows = sorted(episodes_by_show.keys())
    rng = random.Random(42)
    rng.shuffle(all_shows)
    cutoff = int(len(all_shows) * 0.8)
    train_shows = set(all_shows[:cutoff])
    eval_shows = set(all_shows[cutoff:])

    train_count = 0
    eval_count = 0

    with TRAIN_OUT.open("w", encoding="utf-8") as train_f, EVAL_OUT.open(
        "w", encoding="utf-8"
    ) as eval_f:
        for key, meta in episodes_meta.items():
            show_id, ep = key
            scenes = scenes_per_ep.get(key, [])
            blocks = blocks_per_ep.get(key, [])
            if not blocks or not scenes:
                # Skip episodes with no scenes or no blocks in v2
                continue

            total_eps = len(episodes_by_show.get(show_id, []))

            # Per-show metadata with defaults
            defaults = {
                "protagonist_type": "underdog_female",
                "core_theme": "forbidden_romance",
                "content_rating": "PG-13",
            }
            raw_meta = show_meta.get(show_id) or show_meta.get("_default") or {}
            meta_for_show = {**defaults, **raw_meta}

            # Build input control object
            has_cliff = bool(
                meta.get("_v2_stats", {}).get("has_cliffhanger_v2", False)
            )
            stats = meta.get("_v2_stats", {}) or {}
            hook_visual = bool(stats.get("hook_visual_3s"))
            hook_theme = bool(stats.get("hook_theme_7s"))
            hook_emotion = bool(stats.get("hook_emotion_21s"))

            # Arc phase per episode (reuse simple ranges)
            def arc_phase_for_episode(n: int) -> str:
                if n <= 0:
                    return "unknown"
                if 1 <= n <= 3:
                    return "hook"
                if 4 <= n <= 7:
                    return "escalation"
                if 8 <= n <= 21:
                    return "lock_in"
                return "spin_out"

            ep_phase = arc_phase_for_episode(ep)

            scene_objs: List[Dict[str, Any]] = []
            for s in scenes:
                scene_objs.append(
                    {
                        "scene_id": s.get("scene_id"),
                        "location": s.get("location") or s.get("slugline"),
                        "beat_type": s.get("beat_type"),
                        "arc_phase": s.get("arc_phase") or ep_phase,
                        "characters": s.get("characters"),
                    }
                )

            inp = {
                "show_id": show_id,
                "episode": ep,
                "total_episodes_for_show": total_eps,
                "arc_phase": ep_phase,
                "cliffhanger_flag": has_cliff,
                 "hook_profile": {
                     "visual_3s": hook_visual,
                     "theme_7s": hook_theme,
                     "emotion_21s": hook_emotion,
                 },
                "protagonist_type": meta_for_show.get("protagonist_type"),
                "core_theme": meta_for_show.get("core_theme"),
                "content_rating": meta_for_show.get("content_rating"),
                "scenes": scene_objs,
            }

            out_blocks = blocks  # already cleaned and sorted

            record = {"input": inp, "output": out_blocks}

            if show_id in train_shows:
                train_f.write(json.dumps(record, ensure_ascii=False) + "\n")
                train_count += 1
            else:
                eval_f.write(json.dumps(record, ensure_ascii=False) + "\n")
                eval_count += 1

    print(
        f"Built train/eval v2: {train_count} train examples -> {TRAIN_OUT}, "
        f"{eval_count} eval examples -> {EVAL_OUT}"
    )


if __name__ == "__main__":
    build_examples()

