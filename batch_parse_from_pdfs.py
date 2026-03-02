#!/usr/bin/env python3
"""
Batch-parse all show PDFs under DataBase into show.json, episodes.jsonl,
scenes.jsonl, and blocks.jsonl, following the Katherine parser schema.
"""

import json
import re
from pathlib import Path

from pypdf import PdfReader


DATA_DIR = Path("DataBase")

# Episode markers: EPISODE N, Episode N, EP N, EPN
EPISODE_PATTERN = re.compile(r"^EP(?:ISODE)?\s*(\d+)\s*(?:\*)?\s*$", re.I)

# Scene heading patterns - try in order; each returns (ep_num, sc_num, int_ext, location, time_of_day) or None
# Format 1 (Katherine): N-M INT. LOCATION – DAY
SCENE_N_M_INT = re.compile(
    r"^(\d+)[-–—](\d+)[.\s]*(INT\.?|EXT\.?|INT\.?/EXT\.?|INT\./EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING|CONTINUOUS|LATER)?\s*$",
    re.I,
)
# Format 2: SCENE N-M INT. LOCATION – DAY
SCENE_SCENE_N_M = re.compile(
    r"^SCENE\s+(\d+)[-–—](\d+)\s+(INT\.?|EXT\.?|INT\.?/EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING)?\s*$",
    re.I,
)
# Format 3: N-M LOCATION – DAY (no INT/EXT)
SCENE_N_M_LOC = re.compile(
    r"^(\d+)[-–—](\d+)[.\s]*([A-Z][A-Z\s',.-]+?)\s*[-–—]\s*(DAY|NIGHT|MORNING)?\s*$",
)
# Format 3b (The Rose Comes With Thorns): 1.1 EXT. ROOFTOP – DAY1 1  (episode.scene at start)
SCENE_N_DOT_M_INT = re.compile(
    r"^(\d+)\.(\d+)\s+(INT\.?|EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING|CONTINUOUS|LATER)?(?:\s*\d+\s+\d+)?\s*$",
    re.I,
)
# Format 4 (The Vanished Him, etc.): N INT. LOCATION - DAY  (single N = episode, scene 1)
SCENE_N_INT = re.compile(
    r"^(\d+)\s+(INT\.?|EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING|CONTINUOUS|LATER)?\s*$",
    re.I,
)
# Format 5 (Back For You, Daughter's, Unbreakable): INT. LOCATION - DAY1 1  (ep and scene at end; no space between DAY and 1 ok)
SCENE_INT_EP_SC = re.compile(
    r"^(INT\.?|EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING|CONTINUOUS|LATER)?\s*(\d+)\s+(\d+)\s*$",
    re.I,
)
# Format 5b: INT. LOCATION - DAY with numbers attached (DAY1 1)
SCENE_INT_EP_SC_NO_SPACE = re.compile(
    r"^(INT\.?|EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING|CONTINUOUS|LATER)(\d+)\s+(\d+)\s*$",
    re.I,
)
# Format 6 (Unbreakable Bond): EXT. STREET - DAY1 1  (same line, numbers attached to DAY)
SCENE_INT_SUFFIX = re.compile(
    r"^(INT\.?|EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING)\s*(\d+)\s+(\d+)\s*$",
    re.I,
)
# Format 7 (Chasing): INT. LOC - DAY3  (single scene number after time)
SCENE_INT_SCENE_NUM = re.compile(
    r"^(INT\.?|EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING)\s*(\d+)\s*$",
    re.I,
)
# Format 8 (Angels): INT LOCATION - DAY *  (no period after INT/EXT, optional *)
SCENE_INT_NO_DOT = re.compile(
    r"^(INT|EXT)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING|CONTINUOUS|LATER)\s*\*?\s*$",
    re.I,
)
# Format 9 (Angels-style no numbers): INT. LOCATION - DAY * or INT LOCATION - DAY (FLASHBACK)
SCENE_INT_PLAIN = re.compile(
    r"^(INT\.?|EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING|CONTINUOUS|LATER)(?:\s*\(FLASHBACK\))?\s*\*?\s*$",
    re.I,
)
PAGE_MARKER = re.compile(r"^(\d+)\.\s*$")
TRANSITION_PATTERN = re.compile(
    r"^(CUT TO|FADE TO|DISSOLVE TO|FADE IN|FADE OUT)[:\s]*$", re.I
)


def is_character_name(s: str) -> bool:
    """Heuristic: all caps, short, typical character name."""
    s = s.strip()
    if not s or len(s) < 2 or len(s) > 55:
        return False
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return False
    return sum(1 for c in letters if c.isupper()) / len(letters) > 0.85


def is_action_line(s: str) -> bool:
    """Stage direction / narrative - not dialogue. Generic starters to work across shows."""
    s = s.strip()
    if not s or len(s) < 3:
        return False
    # Dialogue often starts with character name (all caps) or parenthetical; action often starts with pronoun/narrative
    action_starts = (
        "She ", "He ", "They ", "It ", "The ", "A ", "An ", "His ", "Her ",
        "Before ", "After ", "Then ", "Suddenly ", "Everyone ", "Inside ", "Outside ",
        "Katherine ", "Arthur ", "Emily ", "Joanna ", "Cole ", "Phoenix ", "Adam ",
        "Shannon ", "Ricky ", "Karen ", "Jessica ", "Vincent ", "Haley ", "Claire ",
        "Ashley ", "Samuel ", "Marina ", "Avery ", "Xavier ", "Miranda ", "Issac ",
        "Young ", "The doctor ", "The young ", "Mr. ", "Mrs. ", "Dr. ",
    )
    for start in action_starts:
        if s.startswith(start) and len(s) > len(start):
            return True
    # All-caps name followed by space and lowercase (e.g. "JESSICA looks") is action
    if re.match(r"^[A-Z][A-Z\s']+\s+[a-z]", s):
        return True
    return False


def clean_block_text(text: str) -> str:
    """Normalize whitespace and strip trailing page markers."""
    if not text:
        return ""
    text = " ".join(text.split())
    text = re.sub(r"\s+\d+\.\s*$", "", text)
    return text.strip()


def _match_scene_heading(stripped: str, current_episode: int, scene_counter: dict):
    """Try each scene pattern; return (ep_num, sc_num, int_ext, location, time_of_day) or None."""
    # Format 1: N-M INT. LOCATION – DAY
    m = SCENE_N_M_INT.match(stripped)
    if m:
        ep_num, sc_num = int(m.group(1)), int(m.group(2))
        int_ext = (m.group(3) or "").strip().rstrip(".")
        location = m.group(4).strip()
        time_of_day = (m.group(5) or "").strip()
        return (ep_num, sc_num, int_ext, location, time_of_day)
    # Format 2: SCENE N-M INT. ...
    m = SCENE_SCENE_N_M.match(stripped)
    if m:
        ep_num, sc_num = int(m.group(1)), int(m.group(2))
        int_ext = (m.group(3) or "").strip().rstrip(".")
        location = m.group(4).strip()
        time_of_day = (m.group(5) or "").strip()
        return (ep_num, sc_num, int_ext, location, time_of_day)
    # Format 3: N-M LOCATION – DAY (no INT/EXT)
    m = SCENE_N_M_LOC.match(stripped)
    if m:
        ep_num, sc_num = int(m.group(1)), int(m.group(2))
        location = m.group(3).strip()
        time_of_day = (m.group(4) or "").strip()
        return (ep_num, sc_num, "", location, time_of_day)
    # Format 3b: 1.1 EXT. ROOFTOP – DAY1 1
    m = SCENE_N_DOT_M_INT.match(stripped)
    if m:
        ep_num, sc_num = int(m.group(1)), int(m.group(2))
        int_ext = (m.group(3) or "").strip().rstrip(".")
        location = m.group(4).strip()
        time_of_day = (m.group(5) or "").strip()
        return (ep_num, sc_num, int_ext, location, time_of_day)
    # Format 4: N INT. LOCATION - DAY (single N = episode, scene 1)
    m = SCENE_N_INT.match(stripped)
    if m:
        ep_num = int(m.group(1))
        int_ext = (m.group(2) or "").strip().rstrip(".")
        location = m.group(3).strip()
        time_of_day = (m.group(4) or "").strip()
        # Same episode can have multiple such headings; use scene 1 for first, then increment
        key = ep_num
        scene_counter[key] = scene_counter.get(key, 0) + 1
        sc_num = scene_counter[key]
        return (ep_num, sc_num, int_ext, location, time_of_day)
    # Format 5 & 5b: INT. LOCATION - DAY N N or DAYN N
    m = SCENE_INT_EP_SC.match(stripped)
    if m:
        int_ext = (m.group(1) or "").strip().rstrip(".")
        location = m.group(2).strip()
        time_of_day = (m.group(3) or "").strip()
        ep_num = int(m.group(4))
        sc_num = int(m.group(5))
        return (ep_num, sc_num, int_ext, location, time_of_day)
    m = SCENE_INT_EP_SC_NO_SPACE.match(stripped)
    if m:
        int_ext = (m.group(1) or "").strip().rstrip(".")
        location = m.group(2).strip()
        time_of_day = (m.group(3) or "").strip()
        ep_num = int(m.group(4))
        sc_num = int(m.group(5))
        return (ep_num, sc_num, int_ext, location, time_of_day)
    m = SCENE_INT_SUFFIX.match(stripped)
    if m:
        int_ext = (m.group(1) or "").strip().rstrip(".")
        location = m.group(2).strip()
        time_of_day = (m.group(3) or "").strip()
        ep_num = int(m.group(4))
        sc_num = int(m.group(5))
        return (ep_num, sc_num, int_ext, location, time_of_day)
    # Format 7: INT. LOC - DAY3 (scene number only)
    m = SCENE_INT_SCENE_NUM.match(stripped)
    if m:
        int_ext = (m.group(1) or "").strip().rstrip(".")
        location = m.group(2).strip()
        time_of_day = (m.group(3) or "").strip()
        sc_num = int(m.group(4))
        ep_num = current_episode if current_episode > 0 else 1
        return (ep_num, sc_num, int_ext, location, time_of_day)
    # Format 8: INT LOCATION - DAY * (no period)
    m = SCENE_INT_NO_DOT.match(stripped)
    if m and current_episode > 0:
        int_ext = (m.group(1) or "").strip() + "."
        location = m.group(2).strip()
        time_of_day = (m.group(3) or "").strip()
        key = current_episode
        scene_counter[key] = scene_counter.get(key, 0) + 1
        sc_num = scene_counter[key]
        return (current_episode, sc_num, int_ext, location, time_of_day)
    # Format 9: INT. LOCATION - DAY (plain; use current episode, increment scene)
    m = SCENE_INT_PLAIN.match(stripped)
    if m and current_episode > 0:
        int_ext = (m.group(1) or "").strip().rstrip(".")
        location = m.group(2).strip()
        time_of_day = (m.group(3) or "").strip()
        # Reject if location looks like dialogue (e.g. "HALEY'S HOME - BEDROOM - DAY" is ok; long text is not)
        if len(location) > 80:
            return None
        key = current_episode
        scene_counter[key] = scene_counter.get(key, 0) + 1
        sc_num = scene_counter[key]
        return (current_episode, sc_num, int_ext, location, time_of_day)
    return None


def parse_script_lines(lines):
    """Core parser logic, adapted from parse_and_populate.parse_script."""
    episodes = []
    scenes = []
    blocks = []
    scene_counter = {}  # per-episode scene index for formats that only give location

    current_episode = 0
    current_scene = 0
    current_scene_location = ""
    current_scene_time = ""
    scene_block_index = 0

    i = 0
    pending_char = None
    pending_parenthetical = None

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Skip
        if not stripped:
            i += 1
            continue
        if "===" in stripped and "PAGE" in stripped:
            i += 1
            continue
        if PAGE_MARKER.match(stripped):
            i += 1
            continue
        if stripped == "THE END":
            i += 1
            continue

        # Episode
        ep_match = EPISODE_PATTERN.match(stripped)
        if ep_match:
            current_episode = int(ep_match.group(1))
            episodes.append({"episode_number": current_episode})
            i += 1
            continue

        # Scene heading
        result = _match_scene_heading(stripped, current_episode, scene_counter)
        if result is not None:
            ep_num, sc_num, int_ext, location, time_of_day = result
            # Ensure episode is in list (some scripts use scene "N INT." without "EP N")
            if not any(e["episode_number"] == ep_num for e in episodes):
                episodes.append({"episode_number": ep_num})
            current_episode = ep_num
            current_scene = sc_num
            scene_block_index = 0
            current_scene_location = (
                f"{int_ext} {location}".strip() if int_ext else location
            )
            current_scene_time = time_of_day

            scenes.append(
                {
                    "episode_number": ep_num,
                    "scene_number": sc_num,
                    "heading": stripped,
                    "location": current_scene_location,
                    "time_of_day": time_of_day,
                }
            )

            blocks.append(
                {
                    "episode_number": ep_num,
                    "scene_number": sc_num,
                    "block_index": scene_block_index,
                    "block_type": "scene_heading",
                    "text": stripped,
                    "location": current_scene_location,
                    "time_of_day": time_of_day,
                }
            )
            scene_block_index += 1
            pending_char = None
            i += 1
            continue

        # Transition
        if TRANSITION_PATTERN.match(stripped):
            blocks.append(
                {
                    "episode_number": current_episode,
                    "scene_number": current_scene,
                    "block_index": scene_block_index,
                    "block_type": "transition",
                    "text": stripped,
                }
            )
            scene_block_index += 1
            i += 1
            continue

        # Parenthetical only - belongs to next character
        if stripped.startswith("(") and stripped.endswith(")") and len(stripped) < 60:
            if pending_char:
                pending_parenthetical = stripped[1:-1]
            i += 1
            continue

        # Character name (all caps) - start of dialogue block
        if is_character_name(stripped):
            dialogue_lines = []
            j = i + 1
            while j < len(lines):
                nl = lines[j].strip()
                if not nl:
                    j += 1
                    continue
                if PAGE_MARKER.match(nl):
                    j += 1
                    continue
                if EPISODE_PATTERN.match(nl):
                    break
                if _match_scene_heading(nl, current_episode, {}) is not None:
                    break
                if re.match(r"^\d+[-–—]\d+", nl) or re.match(r"^\d+\s+(INT\.?|EXT\.?)", nl, re.I) or re.match(r"^\d+\.\d+\s+(INT\.?|EXT\.?)", nl, re.I):
                    break
                if TRANSITION_PATTERN.match(nl):
                    break
                if is_character_name(nl) and nl != stripped:
                    break
                if is_action_line(nl):
                    break
                if nl.startswith("(") and nl.endswith(")"):
                    pending_parenthetical = nl[1:-1]
                    j += 1
                    continue
                dialogue_lines.append(nl)
                j += 1
                if len(dialogue_lines) >= 15:
                    break

            text = clean_block_text(" ".join(dialogue_lines))
            char_clean = stripped.split("(")[0].strip()
            if "(V.O." in stripped or "(O.S." in stripped:
                char_clean = stripped

            blocks.append(
                {
                    "episode_number": current_episode,
                    "scene_number": current_scene,
                    "block_index": scene_block_index,
                    "block_type": "dialogue",
                    "character": char_clean,
                    "parenthetical": pending_parenthetical,
                    "text": text,
                }
            )
            scene_block_index += 1
            pending_char = None
            pending_parenthetical = None
            i = j
            continue

        # Action block - collect until character or scene
        action_lines = [stripped]
        j = i + 1
        while j < len(lines):
            nl = lines[j].strip()
            if not nl:
                j += 1
                continue
            if EPISODE_PATTERN.match(nl):
                break
            if _match_scene_heading(nl, current_episode, {}) is not None:
                break
            if re.match(r"^\d+[-–—]\d+", nl) or re.match(r"^SCENE\s+\d+", nl, re.I) or re.match(r"^\d+\s+(INT\.?|EXT\.?)", nl, re.I) or re.match(r"^\d+\.\d+\s+(INT\.?|EXT\.?)", nl, re.I):
                break
            if TRANSITION_PATTERN.match(nl):
                break
            if is_character_name(nl):
                break
            if nl.startswith("(") and nl.endswith(")"):
                break
            action_lines.append(nl)
            j += 1
            if len(action_lines) >= 20:
                break

        action_text = clean_block_text(" ".join(action_lines))
        if action_text:
            blocks.append(
                {
                    "episode_number": current_episode,
                    "scene_number": current_scene,
                    "block_index": scene_block_index,
                    "block_type": "action",
                    "text": action_text,
                }
            )
            scene_block_index += 1

        i = j if j > i + 1 else i + 1

    return episodes, scenes, blocks


def process_show(show_dir: Path, pdf_path: Path):
    show_id = show_dir.name
    title = pdf_path.stem
    print(f"Processing show '{show_id}' from '{pdf_path.name}'")

    reader = PdfReader(str(pdf_path))
    text_by_page = []
    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        text_by_page.append(f"=== PAGE {i+1} ===\n{text}")

    full_text = "\n\n".join(text_by_page)
    lines = full_text.split("\n")

    episodes, scenes, blocks = parse_script_lines(lines)

    seen = set()
    unique_episodes = [
        ep
        for ep in episodes
        if ep["episode_number"] not in seen and not seen.add(ep["episode_number"])
    ]

    scene_counts = {}
    for s in scenes:
        scene_counts[s["episode_number"]] = (
            scene_counts.get(s["episode_number"], 0) + 1
        )
    for ep in unique_episodes:
        ep["scene_count"] = scene_counts.get(ep["episode_number"], 0)

    blocks = [
        b
        for b in blocks
        if b.get("block_type") != "dialogue" or (b.get("text") or "").strip()
    ]

    scene_blocks = {}
    for b in blocks:
        key = (b["episode_number"], b["scene_number"])
        if key not in scene_blocks:
            scene_blocks[key] = []
        scene_blocks[key].append(b)
    blocks_out = []
    for (ep, sc), blks in sorted(scene_blocks.items()):
        for idx, b in enumerate(blks):
            b["block_index"] = idx
            blocks_out.append(b)
    blocks = blocks_out

    show = {
        "id": show_id,
        "title": title,
        "source": "PDF script",
        "total_episodes": len(unique_episodes),
        "total_scenes": len(scenes),
        "total_blocks": len(blocks),
    }

    output_dir = show_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    with open(output_dir / "show.json", "w", encoding="utf-8") as f:
        json.dump(show, f, indent=2, ensure_ascii=False)

    with open(output_dir / "episodes.jsonl", "w", encoding="utf-8") as f:
        for ep in unique_episodes:
            ep_out = dict(ep)
            ep_out["show_id"] = show_id
            f.write(json.dumps(ep_out, ensure_ascii=False) + "\n")

    with open(output_dir / "scenes.jsonl", "w", encoding="utf-8") as f:
        for s in scenes:
            s_out = dict(s)
            s_out["show_id"] = show_id
            f.write(json.dumps(s_out, ensure_ascii=False) + "\n")

    with open(output_dir / "blocks.jsonl", "w", encoding="utf-8") as f:
        for b in blocks:
            b_out = dict(b)
            b_out["show_id"] = show_id
            f.write(json.dumps(b_out, ensure_ascii=False) + "\n")

    print(
        f"  -> {len(unique_episodes)} episodes, {len(scenes)} scenes, {len(blocks)} blocks"
    )


def main():
    if not DATA_DIR.exists():
        raise SystemExit(f"Data directory not found: {DATA_DIR}")

    for show_dir in sorted(DATA_DIR.iterdir()):
        if not show_dir.is_dir():
            continue
        if show_dir.name == "katherine_heres_your_husband":
            # Already parsed via dedicated script
            continue
        pdfs = list(show_dir.glob("*.pdf"))
        if not pdfs:
            print(f"Skipping {show_dir.name}: no PDF files found")
            continue
        pdf_path = pdfs[0]
        process_show(show_dir, pdf_path)


if __name__ == "__main__":
    main()

