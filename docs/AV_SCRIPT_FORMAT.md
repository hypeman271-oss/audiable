# Handoff: writing scripts for Lyrith (AV format)

**Audience:** the skit-writing agent.
**Goal:** output a script that Lyrith renders cleanly, narrates correctly (dialogue only), and can export as a two-column voice-actor (AV) PDF — with zero post-editing.

Output **plain text / lightweight Markdown**. Do **not** lay out columns yourself — Lyrith builds the two-column AV PDF from the linear script below.

---

## The elements Lyrith understands

Each is detected per **line** (so put each on its own line). Detection mirrors `_avClassifyLine` in `static/app.js`.

| Element | Write it as | On screen | In the audio |
|---|---|---|---|
| **Header field** | `Label: value` where Label ∈ Client/Project, Client, Project, Target Demographic, Demographic, Audience, Voice Spec, Voice, Tone/Pacing, Tone, Pacing, Length, System | Label bold, dimmed block | **Not read aloud**\* |
| **Speaker cue** | `NAME:` then the line — ALL-CAPS, ≥2 letters, at the **start of the line**, then a colon (`NARRATOR:`, `MA:`, `VOICE 1:`) | Cue in accent color | Cue name **not read**; the dialogue **is** |
| **Technical direction** | a whole line in `[brackets]` or `(parens)` — `[SFX: door slams]`, `(Music fades in)` | dimmed italic, set apart | **Not read aloud**\* |
| **Inline direction** | `[…]` inside a dialogue line — `Run [now] fast.` | dimmed inline | the `[…]` is **dropped** from the read |
| **Beat (pause)** | `[BEAT]` on its own line | centered marker | an actual **~0.7s pause** before the next line |
| **Pronunciation note (silent)** | put the respelling in brackets: `Medellín [meh-deh-YEEN]` | dimmed note | the bracket is **dropped**; only `Medellín` is read |

\* **Audio skip is boundary-safe.** Lyrith only removes header/direction lines from the audio when doing so keeps the sentence count identical (so the read-along highlight stays aligned). If it can't, it leaves them in. See the **Rules** below to stay in the safe path.

Markdown also renders everywhere: `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `# headings`, `> blockquote`, `- ` / `1. ` lists, and `***` / `* * *` scene breaks.

---

## Rules that keep it perfect

1. **One element per line.** Never put a cue, a direction, and dialogue on the same physical line if you want them treated separately.
2. **Blank line between turns/blocks.** Separate each speaker turn (and the header block, and each direction) with a blank line. Blank lines become paragraph breaks, so each `NAME:` line stands on its own (this is the look you want).
3. **Speaker cues must be ALL-CAPS, ≥2 letters, line-start, colon.** `NARRATOR:` ✅ · `MA:` ✅ · `VOICE 1:` ✅ · `Note:` ❌ (lowercase → treated as prose) · `I:` ❌ (one letter).
4. **Don't end the script on a bare direction line.** A trailing `(Music swells)` with no terminal punctuation forces the audio strip into its safe fallback (the header may then be read aloud). End on a dialogue line, or give the final direction a period: `(Music swells.)` → still skipped, still safe.
5. **Header goes at the very top**, one field per line, before any dialogue.
6. **Inline directions use brackets, not parens.** Only `[brackets]` are dropped from the read inline; an inline `(aside)` is treated as ordinary spoken text. Use `(parens)` only for a **whole-line** direction.
7. **Phonetics that shouldn't be spoken → brackets** (`Acaí [ah-sah-EE]`). If you want the respelling itself spoken, just write it as the word.

---

## Template (matches Lyrith's built-in "🎬 Start an AV script")

```
Client/Project: <brand or production>
Target Demographic: <who's listening>
Voice Spec: Warm, 30s, Guy/Girl-Next-Door
Tone/Pacing: Up-beat, conversational

NARRATOR: Your opening line — warm and unhurried.

[SFX: a short, telling sound]

[BEAT]

MA: Your next line. Add a pronunciation note inline like Medellín [meh-deh-YEEN].

(Music fades out.)
```

How Lyrith treats that:
- **Reads aloud:** only "Your opening line…", "Your next line. … like Medellín." (with a ~0.7s pause where `[BEAT]` is).
- **Silent:** the four header fields, `[SFX: …]`, `[BEAT]`, and `(Music fades out.)`.
- **On screen:** every element, formatted (header dimmed, cues in accent, directions dimmed-italic, beat centered).
- **AV PDF:** directions land in the left column, cues + dialogue in the right.

---

## Multi-character skits

Use a distinct ALL-CAPS cue per character (`MA:`, `BACHATADONIS:`, `NARRATOR:`). If the author has created Characters in Lyrith with those exact names, each speaker can be narrated in its own assigned voice automatically; otherwise everything reads in the clip's single voice. Either way the cues are styled and not read aloud.

## Don't do
- Don't pre-format two columns, tables, or ASCII art — Lyrith generates the AV PDF.
- Don't rely on indentation for meaning (it's trimmed).
- Don't merge multiple speakers onto one line.
- Don't end on a bare `(...)`/`[...]` direction line (see Rule 4).
