#!/usr/bin/env python3
"""
Phase 1: Parse genre reference scripts (movie/TV) under DataBase/1Genres/.

- Reads only from DataBase/1Genres/<Genre>/*.pdf.
- Extracts raw text per PDF (no vertical structure; no blocks/episodes).
- Writes to DataBase/1Genres_parsed/<Genre>/<script_slug>.txt.

This output is for later anonymization and reference only. It is never
fed into global_blocks, train_v2, or any vertical training pipeline.
"""

from pathlib import Path

from pypdf import PdfReader


DATA_DIR = Path("DataBase")
GENRES_ROOT = DATA_DIR / "1Genres"
PARSED_ROOT = DATA_DIR / "1Genres_parsed"


def extract_text_from_pdf(pdf_path: Path) -> str:
    """Extract raw text from all pages. Returns a single string."""
    reader = PdfReader(str(pdf_path))
    parts = []
    for i, page in enumerate(reader.pages):
        text = page.extract_text()
        if text and text.strip():
            parts.append(text)
    return "\n\n".join(parts)


def main():
    if not GENRES_ROOT.exists():
        print(f"Genre root not found: {GENRES_ROOT}")
        return

    parsed_count = 0
    for genre_dir in sorted(GENRES_ROOT.iterdir()):
        if not genre_dir.is_dir():
            continue
        genre_name = genre_dir.name
        out_genre_dir = PARSED_ROOT / genre_name
        out_genre_dir.mkdir(parents=True, exist_ok=True)

        for pdf_path in sorted(genre_dir.glob("*.pdf")):
            slug = pdf_path.stem
            out_path = out_genre_dir / f"{slug}.txt"
            try:
                text = extract_text_from_pdf(pdf_path)
                if not text.strip():
                    print(f"  [skip] {genre_name}/{pdf_path.name}: no text extracted")
                    continue
                out_path.write_text(text, encoding="utf-8", errors="replace")
                parsed_count += 1
                print(f"  {genre_name}/{pdf_path.name} -> 1Genres_parsed/{genre_name}/{slug}.txt")
            except Exception as e:
                print(f"  [error] {genre_name}/{pdf_path.name}: {e}")

    print(f"\nDone. Parsed {parsed_count} scripts into {PARSED_ROOT}")


if __name__ == "__main__":
    main()
