"""Debug: what does Standard Ebooks return for the Aesop fixture URL?
The corpus runner is downloading something that isn't a zip — the
server now correctly 422s 'invalid EPUB: not a zip archive'. Figure
out why."""
import requests

URL = "https://standardebooks.org/ebooks/aesop/fables/v-s-vernon-jones/downloads/aesop_fables_v-s-vernon-jones.epub"

# Same headers the corpus runner sends today.
UA_RUNNER = "narrative-corpus-runner/1 (https://narrative-alpha.fly.dev)"
# Browser-shaped UA for comparison.
UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/120.0.0.0 Safari/537.36")

for name, ua, extra in [
    ("runner UA, no Accept", UA_RUNNER, {}),
    ("runner UA + Accept: epub+zip", UA_RUNNER, {"Accept": "application/epub+zip"}),
    ("browser UA, no Accept", UA_BROWSER, {}),
    ("browser UA + Accept: epub+zip", UA_BROWSER, {"Accept": "application/epub+zip"}),
]:
    print(f"\n=== {name} ===")
    headers = {"User-Agent": ua, **extra}
    try:
        r = requests.get(URL, headers=headers, timeout=60,
                         allow_redirects=True, stream=False)
    except requests.RequestException as e:
        print(f"  REQUEST FAILED: {e}")
        continue
    print(f"  status: {r.status_code}")
    print(f"  final url: {r.url}")
    print(f"  Content-Type: {r.headers.get('Content-Type')}")
    print(f"  Content-Length: {r.headers.get('Content-Length')}")
    print(f"  Content-Disposition: {r.headers.get('Content-Disposition')}")
    print(f"  body bytes: {len(r.content)}")
    print(f"  first 4 bytes: {r.content[:4]!r}")
    if r.content[:2] == b"PK":
        print("  -> IS A ZIP")
    else:
        body = r.content[:500].decode("utf-8", "replace")
        # Strip Unicode so PowerShell doesn't choke.
        body = body.encode("ascii", "replace").decode("ascii")
        print(f"  -> NOT a zip. body head ({len(r.content)} bytes total):")
        print(body)
