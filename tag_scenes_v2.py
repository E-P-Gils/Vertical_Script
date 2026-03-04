#!/usr/bin/env python3
"""
Phase 3: Tag scenes with canonical beat types and arc phases.

Input (under DataBase/):
  - global_scenes.jsonl   (from build_global_files.py)

Output (under DataBase/):
  - global_scenes_tagged_v2.jsonl

We:
  - Normalize / map scene-level beat_type into a small canonical set.
  - Add arc_phase based on episode number (per show):
        1–3   -> "hook"
        4–7   -> "escalation"
        8–21  -> "lock_in"
        >21   -> "spin_out"
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


DATA_DIR = Path("DataBase")
INPUT_PATH = DATA_DIR / "global_scenes.jsonl"
OUTPUT_PATH = DATA_DIR / "global_scenes_tagged_v2.jsonl"


CANONICAL_BEATS = {
    "jealousy_confrontation",
    "power_play_confrontation",
    "threat_external",
    "betrayal_hint",
    "betrayal_reveal",
    "deal_contract",
    "kidnap_or_capture",
    "rescue_attempt",
    "intimacy_escalation",
    "intimacy_aftermath",
    "secret_identity_hint",
    "secret_identity_reveal",
    "strategy_planning",
    "family_pressure",
    "villain_plotting",
    "trap_sprung",
    "final_cliffhanger",
    # Generic fallbacks
    "generic_conflict",
    "generic_drama",
}


def _normalize_str(x: Any) -> str:
    return str(x).strip().lower() if x is not None else ""


def map_beat_type(raw: Any, location: str = "", text_hint: str = "") -> str:
    """
    Map existing or heuristic beat_type into a canonical value.
    This is intentionally simple for v2; we can refine mappings later.
    """
    r = _normalize_str(raw)

    # Direct passthrough if already canonical
    if r in CANONICAL_BEATS:
        return r

    # Simple keyword-based mapping
    if any(w in r for w in ("jealous", "envy")):
        return "jealousy_confrontation"
    if any(w in r for w in ("threat", "threaten")):
        return "threat_external"
    if "betray" in r:
        if "hint" in r:
            return "betrayal_hint"
        return "betrayal_reveal"
    if any(w in r for w in ("deal", "contract", "signing")):
        return "deal_contract"
    if any(w in r for w in ("kidnap", "abduct", "hostage")):
        return "kidnap_or_capture"
    if any(w in r for w in ("rescue", "save ")):
        return "rescue_attempt"
    if any(w in r for w in ("intimacy", "kiss", "bedroom", "romantic")):
        return "intimacy_escalation"
    if "council" in r or "meeting" in r:
        return "strategy_planning"
    if any(w in r for w in ("family", "mother", "father", "parents")):
        return "family_pressure"
    if any(w in r for w in ("villain", "plot", "scheme")):
        return "villain_plotting"
    if any(w in r for w in ("trap", "ambush")):
        return "trap_sprung"

    # Heuristics from location / hints (very light)
    loc = _normalize_str(location)
    if "bedroom" in loc or "hotel" in loc:
        return "intimacy_escalation"

    # Fallbacks
    if r:
        return "generic_conflict"
    return "generic_drama"


def arc_phase_for_episode(ep: Any) -> str:
    try:
        n = int(ep)
    except (TypeError, ValueError):
        return "unknown"
    if n <= 0:
        return "unknown"
    if 1 <= n <= 3:
        return "hook"
    if 4 <= n <= 7:
        return "escalation"
    if 8 <= n <= 21:
        return "lock_in"
    return "spin_out"


def tag_scenes() -> None:
    if not INPUT_PATH.exists():
        raise FileNotFoundError(f"Missing {INPUT_PATH}")

    tagged = 0

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
                continue

            episode = rec.get("episode") or rec.get("episode_number")
            location = rec.get("location") or rec.get("slugline") or ""
            raw_beat = rec.get("beat_type")

            canonical_beat = map_beat_type(raw_beat, location=location)
            phase = arc_phase_for_episode(episode)

            rec_out = dict(rec)
            rec_out["beat_type"] = canonical_beat
            rec_out["arc_phase"] = phase

            out_f.write(json.dumps(rec_out, ensure_ascii=False) + "\n")
            tagged += 1

    print(f"Tagged {tagged:,} scenes -> {OUTPUT_PATH}")


if __name__ == "__main__":
    tag_scenes()

