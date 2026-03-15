#!/usr/bin/env python3
"""
Phase 2: Anonymize parsed genre scripts and build reference snippets + blocklist.

- Reads from DataBase/1Genres_parsed/<genre>/*.txt
- Extracts character names (ALL CAPS lines, dialogue attribution)
- Extracts locations (INT./EXT. headings, named places)
- Replaces with generic tags: [HERO], [LOVE_INTEREST], [VILLAIN], [SIDEKICK],
  [AUTHORITY], [CHARACTER_N]; [THE CITY], [HEADQUARTERS], [THE SHIP], [THE CASTLE], [LOCATION_N]
- Writes anonymized snippets (200-800 tokens) to DataBase/1Genres_reference/<genre>/snippets.json
- Writes blocklist (names, locations, distinctive terms) to DataBase/1Genres_blocklist.json
"""

import json
import re
from pathlib import Path

DATA_DIR = Path("DataBase")
PARSED_ROOT = DATA_DIR / "1Genres_parsed"
REFERENCE_ROOT = DATA_DIR / "1Genres_reference"
BLOCKLIST_PATH = DATA_DIR / "1Genres_blocklist.json"

# Skip these when treating ALL CAPS line as character name
SKIP_CAPITALIZED = {
    "cut to", "fade in", "fade out", "dissolve to", "int", "ext", "day", "night",
    "continuous", "later", "same", "the end", "v.o", "o.s", "o.c", "cont'd",
    "flashback", "present", "past", "insert", "title", "super", "superimpose",
    "for educational purposes only", "revised", "draft", "scene", "page",
    "int.", "ext.", "day.", "night.", "continuous.", "later.", "same.",
}

# Generic location tags by keyword
LOCATION_KEYWORDS = [
    (["ship", "boat", "vessel", "deck", "harbor", "port"], "[THE SHIP]"),
    (["castle", "tower", "fortress", "keep", "palace", "throne"], "[THE CASTLE]"),
    (["office", "bank", "headquarters", "building", "lobby", "vault", "corporate"], "[HEADQUARTERS]"),
    (["city", "downtown", "street", "gotham", "metropolis", "town"], "[THE CITY]"),
    (["camp", "cabin", "lodge", "lake", "forest", "woods", "jungle"], "[THE WILDERNESS]"),
    (["house", "home", "apartment", "room", "bedroom"], "[THE RESIDENCE]"),
]

# Approximate tokens: ~4 chars per token
MIN_SNIPPET_CHARS = 800   # ~200 tokens
MAX_SNIPPET_CHARS = 3200  # ~800 tokens
TARGET_SNIPPETS_PER_GENRE = 80


def extract_character_names(text: str) -> list[str]:
    """Collect likely character names: standalone ALL CAPS lines (including NAME (V.O.) etc.)."""
    seen = set()
    names = []
    for line in text.splitlines():
        s = line.strip()
        if not s or len(s) < 2 or len(s) > 60:
            continue
        clean = re.sub(r"\s+", " ", s)
        # Allow (V.O.) (O.S.) (O.C.) (CONT'D) etc. at end
        base = re.sub(r"\s*\([VO\.\'\s]+\)\s*$", "", clean, flags=re.I).strip()
        base = re.sub(r"\s*\(CONT\'D\)\s*$", "", base, flags=re.I).strip()
        if not base or len(base) > 45:
            continue
        if re.match(r"^[A-Z][A-Z0-9\s\'\-\.]+$", base) and base.lower() not in SKIP_CAPITALIZED:
            if re.match(r"^(INT|EXT)\.?", base, re.I):
                continue
            if re.match(r"^\d+\s+\d*", base):
                continue
            key = base.upper()
            if key not in seen:
                seen.add(key)
                names.append(base)
    return names


def extract_locations(text: str) -> list[str]:
    """Extract locations from INT./EXT. scene headings and obvious place names."""
    locations = []
    # INT. / EXT. ... - DAY/NIGHT
    for m in re.finditer(r"(?:INT\.|EXT\.)\s*([^-–—\n]+?)\s*[-–—]\s*(?:DAY|NIGHT|CONTINUOUS|LATER|MOMENTS LATER)", text, re.I):
        loc = m.group(1).strip()
        if len(loc) > 1 and len(loc) < 120:
            locations.append(loc)
    # Standalone place-name lines (e.g. "CAMP CRYSTAL LAKE")
    for line in text.splitlines():
        s = line.strip()
        if 3 <= len(s) <= 80 and re.match(r"^[A-Z][A-Za-z\s\']+$", s):
            low = s.lower()
            if low not in SKIP_CAPITALIZED and " " in s:
                locations.append(s)
    return list(dict.fromkeys(locations))  # preserve order, dedupe


def classify_location_tag(loc: str) -> str:
    """Map location string to generic tag."""
    low = loc.lower()
    for keywords, tag in LOCATION_KEYWORDS:
        if any(k in low for k in keywords):
            return tag
    return "[LOCATION]"


def build_character_map(names: list[str]) -> dict[str, str]:
    """Map character names to generic tags. First few get role tags. Include (V.O.)/(O.S.) variants."""
    role_tags = ["[HERO]", "[LOVE_INTEREST]", "[VILLAIN]", "[SIDEKICK]", "[AUTHORITY]"]
    m = {}
    for i, n in enumerate(names):
        key = n.strip()
        if not key:
            continue
        tag = role_tags[i] if i < len(role_tags) else f"[CHARACTER_{i + 1}]"
        m[key] = tag
        m[f"{key} (V.O.)"] = tag
        m[f"{key} (O.S.)"] = tag
        m[f"{key} (O.C.)"] = tag
        m[f"{key} (CONT'D)"] = tag
    return m


def apply_anonymization(text: str, char_map: dict[str, str], loc_map: dict[str, str]) -> str:
    """Replace character names and locations with generic tags."""
    out = text
    # Replace locations first (longer strings first to avoid partial matches)
    for loc, tag in sorted(loc_map.items(), key=lambda x: -len(x[0])):
        if not loc:
            continue
        out = re.sub(re.escape(loc), tag, out, flags=re.IGNORECASE)
    for name, tag in sorted(char_map.items(), key=lambda x: -len(x[0])):
        if not name:
            continue
        # Whole line (character name alone, optional (V.O.) etc.)
        pattern_line = r"^(\s*)" + re.escape(name) + r"(?:\s*\([^)]*\))?\s*$"
        out = re.sub(pattern_line, r"\1" + tag + "\n", out, flags=re.MULTILINE)
        # Inline (word boundary)
        out = re.sub(r"\b" + re.escape(name) + r"\b", tag, out)
    return out


def extract_distinctive_terms(text: str) -> list[str]:
    """Optional: collect short distinctive phrases (e.g. famous lines). Skip for now; extend later."""
    return []


def chunk_into_snippets(anonymized: str, min_chars: int = MIN_SNIPPET_CHARS, max_chars: int = MAX_SNIPPET_CHARS) -> list[str]:
    """Split anonymized text into snippets of roughly 200-800 tokens."""
    snippets = []
    # Split by double newlines (paragraphs) or single long blocks
    blocks = re.split(r"\n\s*\n", anonymized)
    current = []
    current_len = 0
    for b in blocks:
        b = b.strip()
        if not b:
            continue
        blen = len(b) + 2
        if current_len + blen >= min_chars and current:
            combined = "\n\n".join(current)
            if min_chars <= len(combined) <= max_chars * 2:  # allow slightly over
                snippets.append(combined[:max_chars] if len(combined) > max_chars else combined)
            current = []
            current_len = 0
        current.append(b)
        current_len += blen
    if current:
        combined = "\n\n".join(current)
        if len(combined) >= min_chars:
            snippets.append(combined[:max_chars] if len(combined) > max_chars else combined)
    return snippets


def process_genre(genre_name: str) -> tuple[list[str], list[str], list[str], list[str]]:
    """Process all scripts in a genre. Returns (snippets, char_blocklist, loc_blocklist, terms_blocklist)."""
    genre_dir = PARSED_ROOT / genre_name
    if not genre_dir.exists():
        return [], [], [], []
    all_snippets = []
    all_chars = []
    all_locs = []
    all_terms = []
    for txt_path in sorted(genre_dir.glob("*.txt")):
        try:
            text = txt_path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            print(f"  [skip] {genre_name}/{txt_path.name}: {e}")
            continue
        names = extract_character_names(text)
        locations = extract_locations(text)
        char_map = build_character_map(names)
        loc_map = {loc: classify_location_tag(loc) for loc in locations}
        anonymized = apply_anonymization(text, char_map, loc_map)
        snippets = chunk_into_snippets(anonymized)
        all_snippets.extend(snippets)
        all_chars.extend(n.strip() for n in names if n.strip())
        all_locs.extend(loc.strip() for loc in locations if loc.strip())
        all_terms.extend(extract_distinctive_terms(text))
    # Cap snippets per genre
    if len(all_snippets) > TARGET_SNIPPETS_PER_GENRE:
        step = len(all_snippets) / TARGET_SNIPPETS_PER_GENRE
        all_snippets = [all_snippets[int(i * step)] for i in range(TARGET_SNIPPETS_PER_GENRE)]
    return all_snippets, all_chars, all_locs, all_terms


def main():
    if not PARSED_ROOT.exists():
        print(f"Parsed root not found: {PARSED_ROOT}. Run parse_genre_scripts.py first.")
        return

    REFERENCE_ROOT.mkdir(parents=True, exist_ok=True)
    global_chars = []
    global_locs = []
    global_terms = []

    for genre_dir in sorted(PARSED_ROOT.iterdir()):
        if not genre_dir.is_dir():
            continue
        genre_name = genre_dir.name
        snippets, chars, locs, terms = process_genre(genre_name)
        global_chars.extend(chars)
        global_locs.extend(locs)
        global_terms.extend(terms)
        out_dir = REFERENCE_ROOT / genre_name
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file = out_dir / "snippets.json"
        payload = {"genre": genre_name, "snippets": snippets, "count": len(snippets)}
        out_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"  {genre_name}: {len(snippets)} snippets, {len(chars)} names, {len(locs)} locations -> {out_file}")

    # Dedupe blocklist (case-insensitive), keep one casing; filter obvious noise
    def dedupe_lower(items: list[str]) -> list[str]:
        seen = set()
        out = []
        for x in items:
            k = x.strip()
            if not k or len(k) < 2:
                continue
            low = k.lower()
            if low not in seen:
                seen.add(low)
                out.append(k)
        return sorted(out, key=str.lower)

    def filter_characters(names: list[str]) -> list[str]:
        """Keep likely character names: 2–40 chars, no leading 'A '/'THE ', not all punctuation."""
        out = []
        for k in names:
            k = k.strip()
            if not k or len(k) < 2 or len(k) > 40:
                continue
            if k.lower().startswith(("a ", "the ", "an ")):
                continue
            if re.match(r"^[A-Z][A-Z\s\-\.\']+$", k) and sum(c.isalpha() for c in k) >= 2:
                out.append(k)
        return dedupe_lower(out)

    def filter_locations(locs: list[str]) -> list[str]:
        """Keep likely place names: exclude pure scene-number lines."""
        out = []
        for k in locs:
            k = k.strip()
            if not k or len(k) < 2 or len(k) > 100:
                continue
            if re.match(r"^\d+\s*\d*$", k):
                continue
            out.append(k)
        return dedupe_lower(out)

    blocklist = {
        "characters": filter_characters(global_chars),
        "locations": filter_locations(global_locs),
        "phrases": dedupe_lower(global_terms),
    }
    BLOCKLIST_PATH.write_text(json.dumps(blocklist, indent=2), encoding="utf-8")
    print(f"\nBlocklist: {len(blocklist['characters'])} characters, {len(blocklist['locations'])} locations -> {BLOCKLIST_PATH}")


if __name__ == "__main__":
    main()
