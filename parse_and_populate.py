#!/usr/bin/env python3
"""
Parse Katherine script and populate show.json, episodes.jsonl, scenes.jsonl, blocks.jsonl.
"""
import json
import re
from pathlib import Path

SCRIPT_PATH = Path("extracted_script.txt")
OUTPUT_DIR = Path("DataBase/katherine_heres_your_husband")

with open(SCRIPT_PATH, "r", encoding="utf-8") as f:
    full_text = f.read()

lines = full_text.split("\n")

# Scene patterns - multiple formats
# Format 1: N-M INT. LOCATION – DAY  (em dash —, en-dash –, or hyphen -)
# Format 2: N-M. INT. LOCATION - DAY  (period after M)
# Format 3: N-M LOCATION – DAY  (no INT/EXT, e.g. 15-1)
# Format 4: SCENE N-M INT. LOCATION – DAY
SCENE_PATTERNS = [
    re.compile(r"^(\d+)[-–—](\d+)[.\s]*(INT\.?|EXT\.?|INT\.?/EXT\.?|INT\./EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING|CONTINUOUS|LATER)?\s*$", re.I),
    re.compile(r"^SCENE\s+(\d+)[-–—](\d+)\s+(INT\.?|EXT\.?|INT\.?/EXT\.?)\s+(.+?)\s*[-–—]\s*(DAY|NIGHT|MORNING)?\s*$", re.I),
    re.compile(r"^(\d+)[-–—](\d+)[.\s]*([A-Z].+?)\s*[-–—]\s*(DAY|NIGHT|MORNING)?\s*$"),  # No INT/EXT
]

EPISODE_PATTERN = re.compile(r"^EPISODE\s+(\d+)\s*$", re.I)
PAGE_MARKER = re.compile(r"^(\d+)\.\s*$")
TRANSITION_PATTERN = re.compile(r"^(CUT TO|FADE TO|DISSOLVE TO|FADE IN|FADE OUT)[:\s]*$", re.I)


def is_character_name(s):
    """All caps, short, typical character name."""
    s = s.strip()
    if not s or len(s) < 2 or len(s) > 55:
        return False
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return False
    return sum(1 for c in letters if c.isupper()) / len(letters) > 0.85


def is_action_line(s):
    """Stage direction / narrative - not dialogue. Must be explicit; avoid breaking dialogue wrap."""
    s = s.strip()
    if not s or len(s) < 3:
        return False
    # Only break on clear action starters (don't use lowercase - dialogue often wraps with "werewolf", "get", etc.)
    action_starts = (
        "Katherine ", "Arthur ", "Emily ", "Joanna ", "Cole ", "Flash ", "Frost ",
        "Lucas ", "She ", "He ", "They ", "It ", "The ", "A ", "An ", "His ", "Her ",
        "Before ", "After ", "Then ", "Suddenly ", "Everyone ", "Inside ", "Outside ",
        "Arthur's ", "Katherine's ", "Emily's ", "KATHERINE ", "ARTHUR ", "EMILY ",
    )
    for start in action_starts:
        if s.startswith(start) and len(s) > len(start):
            return True
    return False


def clean_block_text(text):
    """Remove page markers and extra whitespace from block text."""
    if not text:
        return ""
    text = " ".join(text.split())
    # Remove trailing " 123." (page numbers)
    text = re.sub(r"\s+\d+\.\s*$", "", text)
    return text.strip()


def parse_script():
    episodes = []
    scenes = []
    blocks = []
    
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
        scene_found = False
        for pat in SCENE_PATTERNS:
            m = pat.match(stripped)
            if m:
                grps = m.groups()
                if len(grps) == 5:
                    ep_num = int(grps[0])
                    sc_num = int(grps[1])
                    int_ext = grps[2].strip().rstrip(".") if grps[2] else ""
                    location = grps[3].strip()
                    time_of_day = (grps[4] or "").strip()
                elif len(grps) == 4:
                    # Pattern 3: no INT/EXT
                    ep_num = int(grps[0])
                    sc_num = int(grps[1])
                    location = grps[2].strip()
                    time_of_day = (grps[3] or "").strip()
                    int_ext = ""
                else:
                    continue
                    
                current_episode = ep_num
                current_scene = sc_num
                scene_block_index = 0
                current_scene_location = f"{int_ext} {location}".strip() if int_ext else location
                current_scene_time = time_of_day
                
                scenes.append({
                    "episode_number": ep_num,
                    "scene_number": sc_num,
                    "heading": stripped,
                    "location": current_scene_location,
                    "time_of_day": time_of_day,
                })
                
                blocks.append({
                    "episode_number": ep_num,
                    "scene_number": sc_num,
                    "block_index": scene_block_index,
                    "block_type": "scene_heading",
                    "text": stripped,
                    "location": current_scene_location,
                    "time_of_day": time_of_day,
                })
                scene_block_index += 1
                pending_char = None
                scene_found = True
                break
        if scene_found:
            i += 1
            continue
            
        # Transition
        if TRANSITION_PATTERN.match(stripped):
            blocks.append({
                "episode_number": current_episode,
                "scene_number": current_scene,
                "block_index": scene_block_index,
                "block_type": "transition",
                "text": stripped,
            })
            scene_block_index += 1
            i += 1
            continue
            
        # Parenthetical only - (panicked), (coldly), etc. - belongs to next character
        if stripped.startswith("(") and stripped.endswith(")") and len(stripped) < 60:
            if pending_char:
                pending_parenthetical = stripped[1:-1]
            i += 1
            continue
            
        # Character name (all caps) - start of dialogue block
        if is_character_name(stripped):
            # Consume dialogue lines only - stop at action
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
                for pat in SCENE_PATTERNS:
                    if pat.match(nl):
                        break
                else:
                    if re.match(r"^\d+[-–—]\d+", nl):
                        break
                if TRANSITION_PATTERN.match(nl):
                    break
                # New character (all caps)
                if is_character_name(nl) and nl != stripped:
                    break
                # Action line - narrative, not dialogue
                if is_action_line(nl):
                    break
                # Skip parenthetical-only lines - we have pending_parenthetical
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
            
            blocks.append({
                "episode_number": current_episode,
                "scene_number": current_scene,
                "block_index": scene_block_index,
                "block_type": "dialogue",
                "character": char_clean,
                "parenthetical": pending_parenthetical,
                "text": text,
            })
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
            for pat in SCENE_PATTERNS:
                if pat.match(nl):
                    break
            else:
                if re.match(r"^\d+[-–—]\d+", nl) or re.match(r"^SCENE\s+\d+", nl, re.I):
                    break
            if TRANSITION_PATTERN.match(nl):
                break
            if is_character_name(nl):
                break
            # Parenthetical alone
            if nl.startswith("(") and nl.endswith(")"):
                break
            action_lines.append(nl)
            j += 1
            if len(action_lines) >= 20:
                break
        
        action_text = clean_block_text(" ".join(action_lines))
        if action_text:
            blocks.append({
                "episode_number": current_episode,
                "scene_number": current_scene,
                "block_index": scene_block_index,
                "block_type": "action",
                "text": action_text,
            })
            scene_block_index += 1
        
        i = j if j > i + 1 else i + 1
    
    return episodes, scenes, blocks


def main():
    print("Parsing script...")
    episodes, scenes, blocks = parse_script()
    
    seen = set()
    unique_episodes = [ep for ep in episodes if ep["episode_number"] not in seen and not seen.add(ep["episode_number"])]
    
    scene_counts = {}
    for s in scenes:
        scene_counts[s["episode_number"]] = scene_counts.get(s["episode_number"], 0) + 1
    for ep in unique_episodes:
        ep["scene_count"] = scene_counts.get(ep["episode_number"], 0)
    
    # Filter out dialogue blocks with empty text (e.g. CONT'D with no dialogue)
    blocks = [b for b in blocks if b.get("block_type") != "dialogue" or (b.get("text") or "").strip()]

    # Renumber block_index per scene to keep continuity
    scene_blocks = {}
    for b in blocks:
        key = (b["episode_number"], b["scene_number"])
        if key not in scene_blocks:
            scene_blocks[key] = []
        scene_blocks[key].append(b)
    blocks = []
    for (ep, sc), blks in sorted(scene_blocks.items()):
        for idx, b in enumerate(blks):
            b["block_index"] = idx
            blocks.append(b)

    show = {
        "id": "katherine_heres_your_husband",
        "title": "Katherine, Here's Your Husband",
        "source": "PDF script",
        "total_episodes": 61,
        "total_scenes": len(scenes),
        "total_blocks": len(blocks),
    }
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    with open(OUTPUT_DIR / "show.json", "w", encoding="utf-8") as f:
        json.dump(show, f, indent=2)
    
    show_id = show["id"]
    with open(OUTPUT_DIR / "episodes.jsonl", "w", encoding="utf-8") as f:
        for ep in unique_episodes:
            ep["show_id"] = show_id
            f.write(json.dumps(ep, ensure_ascii=False) + "\n")

    with open(OUTPUT_DIR / "scenes.jsonl", "w", encoding="utf-8") as f:
        for s in scenes:
            s["show_id"] = show_id
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    with open(OUTPUT_DIR / "blocks.jsonl", "w", encoding="utf-8") as f:
        for b in blocks:
            b["show_id"] = show_id
            f.write(json.dumps(b, ensure_ascii=False) + "\n")
    
    print(f"Done: {len(unique_episodes)} episodes, {len(scenes)} scenes, {len(blocks)} blocks")


if __name__ == "__main__":
    main()
