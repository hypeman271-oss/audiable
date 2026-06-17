"""TOTP two-factor auth — RFC 6238, pure standard library.

Deliberately dependency-free (no `pyotp`): the algorithm is small and the
stdlib has everything (hmac/hashlib/base64/struct/time). Authenticator
apps (Google Authenticator, Authy, 1Password, …) all default to
SHA1 / 6 digits / 30 s, so that's what we emit.

The caller (server.py) owns enrollment state + storage; this module is
pure functions so it's trivially unit-testable with a frozen timestamp.

Companion helpers for one-time recovery codes live here too: generate a
batch, hand the plaintext to the user once, and persist only the sha256
hashes — a DB leak then can't be replayed into the account.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import struct
import time
import urllib.parse

# Authenticator-app defaults. Changing any of these would desync every
# already-enrolled device, so they're fixed.
_DIGITS = 6
_PERIOD = 30  # seconds per step
_ALGO = "SHA1"


def generate_secret() -> str:
    """A fresh base32 TOTP secret (160 bits, unpadded).

    160 bits is the RFC 4226 recommended key length and what Google
    Authenticator expects. base32 with the `=` padding stripped is the
    canonical shape for `otpauth://` URIs + manual entry.
    """
    return base64.b32encode(os.urandom(20)).decode("ascii").rstrip("=")


def _hotp(secret: str, counter: int) -> str:
    """RFC 4226 HOTP for a base32 secret + counter → zero-padded digits."""
    # Re-pad the base32 secret to a multiple of 8 chars before decoding;
    # we store it stripped. Upper-case so lower-case manual entry still
    # decodes.
    s = secret.strip().replace(" ", "").upper()
    s += "=" * ((8 - len(s) % 8) % 8)
    key = base64.b32decode(s)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    # Dynamic truncation (RFC 4226 §5.3).
    offset = digest[-1] & 0x0F
    code_int = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code_int % (10 ** _DIGITS)).zfill(_DIGITS)


def verify(secret: str, code: str, window: int = 1, at: float | None = None) -> bool:
    """True iff `code` is valid for `secret` now (±`window` steps).

    The window absorbs clock skew between the server and the user's phone
    (±1 step = ±30 s by default). Comparison is constant-time. `at` lets
    tests pin the timestamp.
    """
    code = (code or "").strip().replace(" ", "")
    if len(code) != _DIGITS or not code.isdigit():
        return False
    now = time.time() if at is None else at
    counter = int(now // _PERIOD)
    for offset in range(-window, window + 1):
        candidate = _hotp(secret, counter + offset)
        if hmac.compare_digest(candidate, code):
            return True
    return False


def provisioning_uri(secret: str, account: str, issuer: str = "Narrative") -> str:
    """Build the `otpauth://totp/...` URI for the enrollment QR.

    `account` is a human label shown in the authenticator app (e.g. the
    tester's name/email or "Narrative account"). Both label segments and
    the query params are percent-encoded.
    """
    label = urllib.parse.quote(f"{issuer}:{account}")
    params = urllib.parse.urlencode({
        "secret": secret,
        "issuer": issuer,
        "algorithm": _ALGO,
        "digits": _DIGITS,
        "period": _PERIOD,
    })
    return f"otpauth://totp/{label}?{params}"


# ---- One-time recovery codes ------------------------------------------
# A batch the user stashes somewhere safe to get back in if they lose the
# authenticator. We store only sha256 hashes; each code is single-use
# (the server deletes the hash on consumption).

# Crockford-ish alphabet: no 0/1/O/I/L to avoid transcription errors.
_RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_recovery_codes(n: int = 10) -> list[str]:
    """`n` formatted recovery codes, e.g. 'A7K2-9QMP'. Plaintext — show
    the user ONCE; persist only hash_recovery_code() of each."""
    codes = []
    for _ in range(n):
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(8))
        codes.append(f"{raw[:4]}-{raw[4:]}")
    return codes


def normalize_recovery_code(code: str) -> str:
    """Canonicalize user input before hashing/compare: strip spaces +
    dashes, upper-case. So 'a7k2-9qmp', 'A7K29QMP' etc. all match."""
    return (code or "").strip().replace("-", "").replace(" ", "").upper()


def hash_recovery_code(code: str) -> str:
    """sha256 hex of the normalized code — what we persist + compare."""
    return hashlib.sha256(normalize_recovery_code(code).encode("ascii")).hexdigest()
