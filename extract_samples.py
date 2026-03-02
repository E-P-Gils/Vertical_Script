"""Extract first 25 pages from each show PDF for format inspection."""
from pathlib import Path
from pypdf import PdfReader

DATA_DIR = Path("DataBase")
SAMPLES_DIR = Path("script_samples")
SAMPLES_DIR.mkdir(exist_ok=True)
MAX_PAGES = 25

for show_dir in sorted(DATA_DIR.iterdir()):
    if not show_dir.is_dir():
        continue
    pdfs = list(show_dir.glob("*.pdf"))
    if not pdfs:
        continue
    pdf_path = pdfs[0]
    out = SAMPLES_DIR / f"{show_dir.name}.txt"
    try:
        reader = PdfReader(str(pdf_path))
        parts = []
        for i in range(min(MAX_PAGES, len(reader.pages))):
            text = reader.pages[i].extract_text() or ""
            parts.append(f"=== PAGE {i+1} ===\n{text}")
        out.write_text("\n\n".join(parts), encoding="utf-8")
        print(f"Wrote {out} ({min(MAX_PAGES, len(reader.pages))} pages)")
    except Exception as e:
        print(f"Error {show_dir.name}: {e}")
