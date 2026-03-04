#!/usr/bin/env python3
"""
Phase 5: Basic stats report for vertical v2 data.

Inputs:
  - DataBase/episodes_validated_v2.jsonl
  - DataBase/global_blocks_clean.jsonl
  - DataBase/global_scenes_tagged_v2.jsonl
  - train_v2.jsonl

Output:
  - stats_report_v2.txt (in repo root)

This is for sanity-checking:
  - How many shows / episodes are in v2.
  - Average words / blocks per episode.
  - Distribution of arc_phase.
  - Top repeated lines (to spot remaining repetition).
  - Beat_type distribution in train_v2.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Tuple


DATA_DIR = Path("DataBase")
EPISODES_VALID_PATH = DATA_DIR / "episodes_validated_v2.jsonl"
BLOCKS_PATH = DATA_DIR / "global_blocks_clean.jsonl"
SCENES_TAGGED_PATH = DATA_DIR / "global_scenes_tagged_v2.jsonl"
TRAIN_V2_PATH = Path("train_v2.jsonl")

REPORT_PATH = Path("stats_report_v2.txt")


def load_valid_episodes():
    shows = set()
    episode_counts: Dict[str, int] = defaultdict(int)
    total_words = 0

    if not EPISODES_VALID_PATH.exists():
        raise FileNotFoundError(f"Missing {EPISODES_VALID_PATH}")

    with EPISODES_VALID_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = str(rec.get("show_id") or "UNKNOWN_SHOW")
            shows.add(sid)
            episode_counts[sid] += 1
            stats = rec.get("_v2_stats") or {}
            total_words += int(stats.get("word_count") or 0)

    total_episodes = sum(episode_counts.values())
    avg_words = total_words / total_episodes if total_episodes else 0.0
    return shows, episode_counts, total_episodes, avg_words


def top_repeated_lines(limit: int = 20) -> Counter:
    counts: Counter = Counter()
    if not BLOCKS_PATH.exists():
        return counts
    with BLOCKS_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            text = (rec.get("text") or "").strip()
            if not text:
                continue
            counts[text] += 1
    return Counter(dict(counts.most_common(limit)))


def arc_phase_distribution() -> Counter:
    dist: Counter = Counter()
    if not SCENES_TAGGED_PATH.exists():
        return dist
    with SCENES_TAGGED_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            phase = rec.get("arc_phase") or "unknown"
            dist[str(phase)] += 1
    return dist


def beat_type_distribution_in_train() -> Counter:
    dist: Counter = Counter()
    if not TRAIN_V2_PATH.exists():
        return dist
    with TRAIN_V2_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            inp = rec.get("input") or {}
            scenes = inp.get("scenes") or []
            for s in scenes:
                bt = s.get("beat_type") or "unknown"
                dist[str(bt)] += 1
    return dist


def main():
    shows, episode_counts, total_episodes, avg_words = load_valid_episodes()
    top_lines = top_repeated_lines()
    arc_dist = arc_phase_distribution()
    beat_dist = beat_type_distribution_in_train()

    lines: list[str] = []

    lines.append("=== Vertical v2 Data Stats ===")
    lines.append("")
    lines.append(f"Valid shows: {len(shows)}")
    lines.append(f"Valid episodes: {total_episodes}")
    lines.append(f"Average words per valid episode: {avg_words:.1f}")
    lines.append("")
    lines.append("Episodes per show (top 20):")
    for sid, cnt in sorted(episode_counts.items(), key=lambda kv: kv[1], reverse=True)[:20]:
        lines.append(f"  {sid}: {cnt}")
    lines.append("")

    lines.append("Arc phase distribution (scene-level):")
    total_scenes = sum(arc_dist.values())
    for phase, cnt in arc_dist.most_common():
        pct = (cnt / total_scenes * 100) if total_scenes else 0
        lines.append(f"  {phase}: {cnt} ({pct:.1f}%)")
    lines.append("")

    lines.append("Beat type distribution in train_v2 (scene-level, via input.scenes):")
    total_beats = sum(beat_dist.values())
    for bt, cnt in beat_dist.most_common():
        pct = (cnt / total_beats * 100) if total_beats else 0
        lines.append(f"  {bt}: {cnt} ({pct:.1f}%)")
    lines.append("")

    lines.append("Top repeated block texts (up to 20):")
    for text, cnt in top_lines.items():
        snippet = text.replace("\n", " ")
        if len(snippet) > 120:
            snippet = snippet[:117] + "..."
        lines.append(f"- [{cnt}x] {snippet}")

    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote stats report to {REPORT_PATH}")


if __name__ == "__main__":
    main()

