# Polyglot — a bilingual translator & proofreader for Raycast

Three commands, all on **Google Gemini** (free tier — the key is free, see below):

1. **Translate** — a RU⇄EN translator that **figures out the direction itself** and, when
   useful, adds a learning breakdown. No "target language" to pick: type Russian and you get
   English, type English and you get Russian. Below the translation, **when it helps**, an
   explanation block appears (meanings, idioms, false friends, grammar) — a plain translator
   turned study tool.
2. **Proofread** — fix grammar, spelling, punctuation and awkward word order in the
   **selected text, in place**, keeping your wording and tone. For Slack / Teams / chat.
3. **Proofread Formal** — the same, but also rewrites the text into a polished formal
   register. For a corporate email.

The two Proofread commands are **no-view**: you assign a hotkey, select text in any app, press
it, and the corrected text lands back where the selection was — no window opens.

> 📸 _Screenshot: drop `metadata/translate.png` here after the first run
> (`npm run dev` → run the command → screenshot the result window)._

## Features

- **Auto-flip RU⇄EN.** The model picks the direction from the dominant language of the input.
- **Term protection.** Proper nouns, brands, dev-stack names (React Native, TypeScript, MobX,
  API/class/hook names), code, identifiers and URLs are **kept verbatim**.
- **Dictionary mode.** A single word yields a full entry: meanings, transcription, forms, examples.
- **Conditional explanation block.** Plain, unambiguous sentences get no block (no noise);
  polysemous words, idioms, phrasal verbs, slang, jargon and genuinely ambiguous phrases get
  one that explains exactly the tricky spots (see [below](#the-explanation-block)).

## Proofread — in place

The **Proofread** and **Proofread Formal** commands correct the **currently selected text**
without opening a window — the whole interaction is a single HUD line.

- **Assign a hotkey.** These commands are only useful on a hotkey: Raycast → Extensions →
  **Polyglot → Proofread** (and **Proofread Formal**) → *Record Hotkey*. Pick two shortcuts you
  can hit while editing anywhere.
- **Casual vs formal.** *Proofread* fixes grammar, spelling and punctuation while keeping your
  exact wording, tone and register (lowercase sentence starts, missing final period, slang and
  emoji are all left alone). It also repairs word order that is unnatural for the output
  language — e.g. a Russian-style trailing adverb in an English sentence — but never
  reshuffles a sentence that already reads natively. *Proofread Formal* also rewrites the
  text into a polished formal register — it may swap casual words for formal ones and
  tighten phrasing, but keeps your meaning and adds nothing.
- **Output language** (preference). By default (`auto`) the result stays in the text's own
  language. Set **Proofread Output Language** to a language name (e.g. `English`) and both
  commands always produce that language: text already in it is simply proofread, anything else
  is **translated into it** — keeping your tone in casual mode, formalized in formal mode.
  Typical setup for a Russian speaker working in English-speaking chats: set it to `English`
  and hit the same hotkey no matter which language the draft came out in.
- **Paste-back vs clipboard.** If text is selected, the result is **pasted straight over the
  selection**. If nothing is selected, Polyglot falls back to the **clipboard**: it proofreads
  the clipboard contents and copies the result back for you to paste. Surrounding whitespace of
  the selection (leading/trailing spaces and newlines) is preserved.
- **Paste Mode** (preference). Rich-text apps — Microsoft Teams, Slack — turn a normal paste's
  line breaks into spaced-out paragraphs. The default mode **Plain** pastes with *match style*
  (`⇧⌘V`), which avoids that; it needs **Accessibility** permission for Raycast (macOS System
  Settings → Privacy & Security → Accessibility), and falls back to a normal paste if the
  permission is missing. Caveat: a few apps bind `⇧⌘V` to something else (e.g. VS Code) — there
  the paste won't land; the result is always left on the clipboard as a backup (`⌘V`), or
  switch to **Normal** mode. Other modes: **Normal** (`⌘V`) and **Copy only** (never paste,
  just put the result on the clipboard).
- **Line breaks, markup, punctuation.** The prompt pins down three things models love to
  "improve": the author's line structure is kept exactly (no merged lines, no invented blank
  lines — model-added blank lines are also stripped in code), markup (Markdown / Jira wiki /
  HTML — bullets, `h1.` headings, `[link|url]`, `{code}` blocks) is reproduced verbatim with
  only the prose inside corrected, and no em dashes (—) / double hyphens (--) / smart quotes
  are introduced if the author didn't write them.
- **10 000-character guard.** Selections longer than ~10k characters are refused with a HUD
  warning and no model call — so a truncated response can never be pasted over a big selection.

### Mixed-language input (auto mode)

With the default `auto` output language, the proofreader detects the **dominant** language and
works in it — it **never translates the whole text**. But an inline fragment written in another
language (you blanked on a word and dropped in your native one mid-sentence) is folded into the
dominant language:

> `please отправить me the report` → `please send me the report`

Protected terms — brands, code, CLI commands, URLs, versions — are always kept verbatim.

**Honest limitation.** The line between "a foreign fragment to translate" and "a loanword to
keep" is inherently fuzzy. Loanwords written in the dominant language's own alphabet are meant
to stay (in Russian, «ресёрч», «запушь», «пофиксить» are kept, not turned back into
`research` / `push` / `fix`), and the tie-breaker is *everyday word → translate, jargon / tool /
brand → keep*. On genuinely ambiguous tokens the model can still guess wrong; if it does,
undo and re-select a tighter range.

## Requirements

- **Raycast** (macOS).
- **Node.js ≥ 22.22.2.** It also builds on 22.19, but `@raycast/api` 1.104 asks for ≥ 22.22.2
  in `engines` — if `npm run dev` complains, upgrade Node (22.22+ or 24).
- **A free Gemini API key** — see below.

## Free Gemini key

Gemini has a free tier, but the API is **key-based** — there is no anonymous access. The key
is free: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) → **Create
API key** (a Google account is required). Copy the generated key (it may start with `AIza…` or
`AQ.…`). The free-tier quota is more
than enough for personal use. The key is stored in Raycast's secure preference storage — no
`.env`, no hardcoding.

## Install (local, not published to the Store)

```bash
git clone https://github.com/MakarUrbanov/polyglot-raycast.git
cd polyglot-raycast
npm install
npm run dev
```

`npm run dev` builds the extension and registers all three commands — **Translate**,
**Proofread**, **Proofread Formal** — in your running Raycast (with hot reload). Find them in
Raycast by searching `Translate`, `Proofread`, or `Polyglot`.

- Assign a global hotkey: Raycast → Extensions → **Polyglot → <command>** → *Record Hotkey*.
  The Proofread commands are really only useful on a hotkey (select text, press, done).
- Open preferences (in Raycast: select a command and press `⌘ ,`, or use *Open Extension
  Preferences* / *Get a Free Key* right from the error screen) and paste the key.

When you're done, you can stop `npm run dev` (`Ctrl-C`) — the **extension stays installed** in
Raycast as a local one.

### Local dev extension vs the Store

This is a local extension **for personal use** — it is not published to the Raycast Store. An
extension imported via `npm run dev` lives on your machine, **does not update from the Store**,
and does not depend on it. Stopping the dev server does not remove the command — it keeps
working. That is exactly the mode you want for a personal tool.

## Preferences

All settings are standard Raycast preferences (the key is stored in Raycast's secure storage).
They are split into **global** settings (shared by every command) and settings **specific to
the Translate command**.

**Global** (apply to all three commands):

| Setting | Type | Default | Purpose |
|---|---|---|---|
| **Gemini API Key** | password | — | Free key — [aistudio.google.com](https://aistudio.google.com/app/apikey). |
| **Gemini Model** | text | `gemini-2.5-flash` | Gemini model ID. |
| **Proofread Output Language** | text | `auto` | Proofread commands only: `auto` keeps each text's own language; a language name (e.g. `English`) makes Proofread always produce that language, translating when needed. |
| **Paste Mode** | dropdown | `Plain` | Proofread commands only: how the result replaces the selection — plain match-style `⇧⌘V` (no extra blank lines in Teams/Slack; needs Accessibility), normal `⌘V`, or copy-only. |

**Translate command only** (Raycast shows these on the Translate command's own settings, not
the extension-wide ones):

| Setting | Type | Default | Purpose |
|---|---|---|---|
| **Explanation Language** | text | `Russian` | Language of the explanation block (any: `English`, `German`, …). |
| **Always Explain** | checkbox | `off` | Force the block even for simple phrases. |

The Proofread commands add no preferences of their own — they use the global key and model.
The model is just a string ID, so when a new version ships you change the preference without
touching code. Free-tier models: `gemini-2.5-flash` (default), `gemini-2.5-flash-lite`,
`gemini-3.5-flash` (more capable, but noticeably pricier on the paid tier).

If the key is empty or invalid, the command shows a clear message with **Get a Free Key (AI
Studio)** and **Open Extension Preferences** actions.

## The explanation block

The block is **not always shown** — the model decides:

- **a single word / short idiom (≤ ~3 words)** → always, in full (dictionary mode);
- **a sentence with a polysemous word / idiom / phrasal verb / slang / term / false friend /
  non-obvious register, or genuine ambiguity** → a block explaining exactly those spots;
- **a plain, unambiguous sentence** → no block (translation only);
- **a long text** → a short block only if there's something worth explaining.

Block sections (all optional, empty ones dropped): part of speech & forms · pronunciation ·
meanings · examples in context · nuance/connotation/register · synonyms/antonyms ·
idiom/phrasal verb · grammar note. The whole block is in `Explanation Language`, except the
example words/sentences in the studied languages.

The **Always Explain** checkbox forces a block even on simple phrases.

## Testing the logic without the UI (eval harness)

The prompt logic (the main risk) is validated **headless**, bypassing the Raycast modal — the
core `translate()` / `proofread()` are called directly, with the key from an env var. There are
two suites: `translate` and `proofread`.

```bash
# both suites, every case
GEMINI_API_KEY=... npm run eval

# one suite
GEMINI_API_KEY=... npm run eval -- --suite translate     # reproduces the old behavior exactly
GEMINI_API_KEY=... npm run eval -- --suite proofread

# proofread in formal mode (enables the formal-only case 9, skips casual-only cases)
GEMINI_API_KEY=... npm run eval -- --suite proofread --formal

# proofread with a fixed output language (enables the --to-only cases 16-17)
GEMINI_API_KEY=... npm run eval -- --suite proofread --to English

# a specific case within the selected suite(s)
GEMINI_API_KEY=... npm run eval -- --suite translate --case 6
GEMINI_API_KEY=... npm run eval -- --lang English        # translate block language
GEMINI_API_KEY=... npm run eval -- --model gemini-2.5-flash-lite

npm run eval -- --list                       # list both suites
npm run eval -- --suite proofread --case 11  # "empty key" — works without a key
npm run eval -- --help                       # all flags
```

Some cases carry a programmatic auto-check (translate: block absent / terms kept / auth error;
proofread: informal register kept, no trailing period, stays in the source language, foreign
fragment folded in, loanword kept, protected terms kept, line breaks kept, markup kept, no em
dash introduced, calqued word order fixed but natural order untouched, auth error); the rest
are printed for eyeballing. Without a key only the
empty-key cases run — the rest are `SKIP`. Env key: `GEMINI_API_KEY`.

## Architecture

```
src/
  translate.tsx        # Translate command (view): the file that imports @raycast/api — Form → Detail
  proofread.tsx        # Proofread command (no-view): runProofread(false)
  proofread-formal.tsx # Proofread Formal command (no-view): runProofread(true)
  run-proofread.ts     # no-view runner: selection → clipboard fallback, whitespace, HUD, errors
  prompts/
    translate.ts       # translate system prompt: the flip, term protection, block rules
    proofread.ts       # proofread system prompt: monolingual guard, fragments, style, output
    shared.ts          # shared protected-terms block + <input> fencing helper
  providers/
    index.ts           # translate() / proofread() entry points + default model
    types.ts           # Base/Translate/Proofread Options + Results
    gemini.ts          # Gemini generateContent (shared callGemini; JSON vs plain-text config)
  lib/
    http.ts            # postJson: timeout (AbortController) + status mapping
    parse.ts           # defensive parsing (translate JSON + proofread fence/quote stripping)
    errors.ts          # ProviderError discriminated by kind
scripts/
  eval.ts              # headless test-case runner (translate + proofread suites)
```

The key point: the **core (`prompts`/`providers`/`lib`) does not depend on `@raycast/api`** —
the provider receives `apiKey`/`model` as explicit arguments (DI). The same `translate()` /
`proofread()` run in both the UI and the eval harness. Translate returns
`{ translation, explanation | null }` in **one request**; proofread returns `{ text }`. Parsing
is resilient to model misbehavior (strips ``` fences, extracts the first JSON object or strips
wrapping quotes, falls back to raw text). No streaming — one request, wait for the full
response. The `gemini.ts` layer is kept as a seam: re-adding other providers means restoring
their modules from git history and adding a dispatcher.

## Security notes

- The API key travels only in the `x-goog-api-key` request header — never in the URL, logs, or
  the UI, and it is never committed (`.gitignore` covers generated files; preferences hold it).
- Model output is treated as untrusted: it is rendered as markdown in `Detail`, and image
  syntax (`![](…)`) is defanged so a crafted translation can't auto-load a remote image.
- The `<input>…</input>` delimiter limits prompt injection; impact is bounded since the only
  actor is the user translating their own text.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | dev mode with hot reload, registers the command in Raycast |
| `npm run build` | production build (`ray build`) |
| `npm run lint` | `ray lint` (ESLint + Prettier + manifest validation) |
| `npm run fix-lint` | auto-fix lint/formatting |
| `npm run eval` | headless run of the test cases (Gemini) |

> Note: `npm run lint` flags one rule — the `author` field (`makarurbanov`) is not registered
> in the Raycast user registry. It doesn't affect local use; set your own Raycast username
> (Raycast → Settings → Account) for a clean lint.

## License

[MIT](LICENSE).
