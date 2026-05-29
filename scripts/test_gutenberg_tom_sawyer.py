import sys
sys.path.insert(0, r"E:\audiable")
from extract import fetch_and_extract_url
import re

URL = "https://www.gutenberg.org/cache/epub/74/pg74-images.html"
result = fetch_and_extract_url(URL)
text = result["text"]
print(f"Total chars: {len(text)}, lines: {len(text.split(chr(10)))}")

# Known opening lines of various chapters in Tom Sawyer
needles = [
    ("Ch1 opening", "No answer"),
    ("Ch2 opening", "Saturday morning"),
    ("Ch3 opening", "Tom presented himself before Aunt Polly"),
    ("Ch4 opening", "The sun rose"),
    ("Ch5 opening", "About half-past ten"),
    ("Ch10 opening", "The two boys flew on"),
    ("Ch35 opening (last)", "The reader may rest satisfied"),
]
for label, needle in needles:
    i = text.find(needle)
    if i > 0:
        print(f"\n[{label}] {needle!r} @ {i}")
        # Show 300 chars before
        print("  PRE:", repr(text[max(0,i-300):i]))

# Now check: pattern that could ID chapter boundaries
# Are there ANY all-caps headings / standalone short lines that could be it?
print("\n--- ALL SHORT LINES (1-30 chars, non-empty) at positions of interest ---")
# Around char 4700 (Ch1 start), and find a couple more
lines = text.split("\n")
# Walk lines and print short non-empty ones
for i, line in enumerate(lines):
    s = line.strip()
    if 1 <= len(s) <= 30 and i > 18:  # skip preface header rows
        if i < 100:
            print(f"  [{i}] {s!r}")
