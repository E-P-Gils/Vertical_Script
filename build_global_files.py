#!/usr/bin/env python3
"""
Build global *.jsonl aggregates across all shows.

Outputs (under DataBase/):
- global_blocks.jsonl
- global_scenes.jsonl
- global_episodes.jsonl

These complement the per-show files:
- DataBase/<show_id>/blocks.jsonl
- DataBase/<show_id>/scenes.jsonl
- DataBase/<show_id>/episodes.jsonl
"""

import json
from pathlib import Path


DATA_DIR = Path("DataBase")
GLOBAL_BLOCKS = DATA_DIR / "global_blocks.jsonl"
GLOBAL_SCENES = DATA_DIR / "global_scenes.jsonl"
GLOBAL_EPISODES = DATA_DIR / "global_episodes.jsonl"


def iter_show_dirs():
    if not DATA_DIR.exists():
        return
    for d in sorted(DATA_DIR.iterdir()):
        if d.is_dir():
            yield d


def build_global_blocks():
    with GLOBAL_BLOCKS.open("w", encoding="utf-8") as out_f:
        for show_dir in iter_show_dirs():
            show_id = show_dir.name
            blocks_path = show_dir / "blocks.jsonl"
            if not blocks_path.exists():
                continue
            with blocks_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    # Base identifiers
                    ep = rec.get("episode_number")
                    sc = rec.get("scene_number")
                    bi = rec.get("block_index")

                    # Add/normalize fields without removing existing ones
                    rec.setdefault("show_id", show_id)
                    if ep is not None:
                        rec["episode"] = ep
                    # Standardize type / speaker fields for training
                    if "block_type" in rec:
                        rec.setdefault("type", rec["block_type"])
                    if "character" in rec:
                        rec.setdefault("speaker", rec.get("character"))

                    # Scene / block IDs (string IDs are convenient for indexing)
                    if ep is not None and sc is not None:
                        scene_id = f"E{ep}_S{sc}"
                        rec.setdefault("scene_id", scene_id)
                        if bi is not None:
                            rec.setdefault("block_id", f"{scene_id}_B{bi}")

                    out_f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def build_global_scenes():
    with GLOBAL_SCENES.open("w", encoding="utf-8") as out_f:
        for show_dir in iter_show_dirs():
            show_id = show_dir.name
            scenes_path = show_dir / "scenes.jsonl"
            if not scenes_path.exists():
                continue
            with scenes_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    ep = rec.get("episode_number")
                    sc = rec.get("scene_number")

                    rec.setdefault("show_id", show_id)
                    if ep is not None:
                        rec.setdefault("episode", ep)
                    if ep is not None and sc is not None:
                        rec.setdefault("scene_id", f"E{ep}_S{sc}")

                    out_f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def build_global_episodes():
    with GLOBAL_EPISODES.open("w", encoding="utf-8") as out_f:
        for show_dir in iter_show_dirs():
            show_id = show_dir.name
            episodes_path = show_dir / "episodes.jsonl"
            if not episodes_path.exists():
                continue
            with episodes_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    ep = rec.get("episode_number")

                    rec.setdefault("show_id", show_id)
                    if ep is not None:
                        rec.setdefault("episode", ep)

                    out_f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def main():
    build_global_blocks()
    build_global_scenes()
    build_global_episodes()
    print("Built global_blocks.jsonl, global_scenes.jsonl, global_episodes.jsonl under DataBase/")


if __name__ == "__main__":
    main()

