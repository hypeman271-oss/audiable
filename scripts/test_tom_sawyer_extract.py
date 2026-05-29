import sys
sys.path.insert(0, r"E:\audiable")
from extract import fetch_and_extract_url

# Try Standard Ebooks first (single-page format)
URL = "https://standardebooks.org/ebooks/mark-twain/the-adventures-of-tom-sawyer/text/single-page"
try:
    result = fetch_and_extract_url(URL)
    text = result["text"]
    print(f"=== SOURCE: Standard Ebooks ===")
except Exception as e:
    print(f"Standard Ebooks failed: {e}")
    URL = "https://www.gutenberg.org/cache/epub/74/pg74-images.html"
    result = fetch_and_extract_url(URL)
    text = result["text"]
    print(f"=== SOURCE: Project Gutenberg ===")

print(f"=== TOTAL CHARS: {len(text)} ===")
print(f"=== FIRST 3000 CHARS ===")
print(text[:3000])
print()
print(f"=== LINE-BY-LINE: lines containing 'chapter' (case-insensitive), first 20 ===")
count = 0
for i, line in enumerate(text.split("\n")):
    if "chapter" in line.lower():
        print(f"  [{i}] {line[:120]!r}")
        count += 1
        if count >= 20:
            break
print()
print(f"=== LINES STARTING WITH # (markdown headings), first 20 ===")
count = 0
for i, line in enumerate(text.split("\n")):
    if line.lstrip().startswith("#"):
        print(f"  [{i}] {line[:120]!r}")
        count += 1
        if count >= 20:
            break
print()
print(f"=== BLANK / TOTAL LINES ===")
print(f"  blank lines: {sum(1 for ln in text.split(chr(10)) if not ln.strip())}")
print(f"  total lines: {len(text.split(chr(10)))}")
