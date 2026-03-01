"""Extract text from Katherine script PDF."""
from pypdf import PdfReader

pdf_path = r"DataBase\katherine_heres_your_husband\Katherine, Here's Your Husband.pdf"
reader = PdfReader(pdf_path)
text_by_page = []
for i, page in enumerate(reader.pages):
    text = page.extract_text() or ""
    text_by_page.append(text)

# Save full text to file for inspection
with open("extracted_script.txt", "w", encoding="utf-8") as f:
    for i, t in enumerate(text_by_page):
        f.write(f"=== PAGE {i+1} ===\n")
        f.write(t)
        f.write("\n\n")

print(f"Extracted {len(text_by_page)} pages")
print("First 3000 chars of page 1:")
print(text_by_page[0][:3000] if text_by_page else "No text")
