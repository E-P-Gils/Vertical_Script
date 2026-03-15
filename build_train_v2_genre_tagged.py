#!/usr/bin/env python3
"""
Phase 3 (Option B): Build genre-tagged training/eval JSONL for vertical v2.

Same as build_train_v2_jsonl (vertical-only episodes, same split), but each
example's input is augmented with:
  - genre_tag: one of Action, Adventure, Crime_Mob, Drama, Horror, etc.
  - setting_hint: one short generic line (no IP) for that genre.

Output is still vertical-format blocks only. Genre scripts never appear as
target output; the model learns "when you see GENRE=X, still output vertical
format" and can apply flavor at inference from anonymized reference.

Outputs (repo root):
  - train_v2_genre_tagged.jsonl
  - eval_v2_genre_tagged.jsonl
"""

from __future__ import annotations

import json
import random
from pathlib import Path

# Reuse build logic from main trainer
from build_train_v2_jsonl import (
    EXCLUDED_SHOW_IDS,
    load_blocks,
    load_scenes,
    load_show_metadata,
    load_valid_episodes,
)

TRAIN_GENRE_OUT = Path("train_v2_genre_tagged.jsonl")
EVAL_GENRE_OUT = Path("eval_v2_genre_tagged.jsonl")

# Generic one-line setting hints per genre (no IP, no character/place names from genre scripts)
GENRE_TAG_SETTING_HINTS = {
    "Action": "High stakes, physical conflict, [THE CITY] or [HEADQUARTERS], tension.",
    "Adventure": "Quest, journey, [THE WILDERNESS] or [THE SHIP], discovery, danger.",
    "Crime_Mob": "Power, loyalty, [HEADQUARTERS], [THE CITY], moral tension.",
    "Drama": "Emotional stakes, relationships, [THE RESIDENCE] or [THE CITY], conflict.",
    "Horror": "Dark atmosphere, fear, tension, [THE RESIDENCE] or [THE CITY].",
    "Medieval_Fantasy": "Swords, [THE CASTLE], quests, power, honor.",
    "Monster": "Threat, survival, [THE CITY] or [THE WILDERNESS], tension.",
    "SciFi": "Future or alien setting, technology, [HEADQUARTERS], stakes.",
    "Superhero": "Heroes, stakes, [HEADQUARTERS], [THE CITY], conflict.",
    "NORMAL": None,  # No extra flavor; vertical drama as-is
}


def build_genre_tagged_examples():
    episodes_meta, episodes_by_show = load_valid_episodes()
    scenes_per_ep = load_scenes()
    blocks_per_ep = load_blocks()
    show_meta = load_show_metadata()

    all_shows = sorted(episodes_by_show.keys())
    rng = random.Random(42)
    rng.shuffle(all_shows)
    cutoff = int(len(all_shows) * 0.8)
    train_shows = set(all_shows[:cutoff])
    eval_shows = set(all_shows[cutoff:])

    genre_tags = [g for g in GENRE_TAG_SETTING_HINTS if g != "NORMAL"]
    train_count = 0
    eval_count = 0

    with TRAIN_GENRE_OUT.open("w", encoding="utf-8") as train_f, EVAL_GENRE_OUT.open(
        "w", encoding="utf-8"
    ) as eval_f:
        for key, meta in episodes_meta.items():
            show_id, ep = key
            if show_id in EXCLUDED_SHOW_IDS:
                continue
            scenes = scenes_per_ep.get(key, [])
            blocks = blocks_per_ep.get(key, [])
            if not blocks or not scenes:
                continue

            total_eps = len(episodes_by_show.get(show_id, []))
            defaults = {
                "protagonist_type": "underdog_female",
                "core_theme": "forbidden_romance",
                "content_rating": "PG-13",
            }
            raw_meta = show_meta.get(show_id) or show_meta.get("_default") or {}
            meta_for_show = {**defaults, **raw_meta}

            has_cliff = bool(meta.get("_v2_stats", {}).get("has_cliffhanger_v2", False))
            stats = meta.get("_v2_stats", {}) or {}
            hook_visual = bool(stats.get("hook_visual_3s"))
            hook_theme = bool(stats.get("hook_theme_7s"))
            hook_emotion = bool(stats.get("hook_emotion_21s"))

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
            scene_objs = []
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

            inp_base = {
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

            # Assign one random genre per example so model sees mix of genre tags
            genre_tag = rng.choice(genre_tags)
            setting_hint = GENRE_TAG_SETTING_HINTS.get(genre_tag)
            inp = {**inp_base, "genre_tag": genre_tag}
            if setting_hint:
                inp["setting_hint"] = setting_hint

            record = {"input": inp, "output": blocks}
            line = json.dumps(record, ensure_ascii=False) + "\n"

            if show_id in train_shows:
                train_f.write(line)
                train_count += 1
            else:
                eval_f.write(line)
                eval_count += 1

    print(
        f"Built genre-tagged train/eval: {train_count} -> {TRAIN_GENRE_OUT}, "
        f"{eval_count} -> {EVAL_GENRE_OUT}"
    )


if __name__ == "__main__":
    build_genre_tagged_examples()
