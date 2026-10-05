# Polyglot — a bilingual translator & proofreader for Raycast

Three commands, on **OpenAI** (default) or **Google Gemini** (free tier — the key is free, see
below). Store both keys if you like; the **Provider** preference picks which one runs:

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
- **Streaming.** By default the translation appears as soon as it streams in, and the
  explanation streams in below it. Two other modes: wait for the whole result, or translate
  first and explain only when you press Enter (see [Explanation modes](#explanation-modes)).
- **No hidden reasoning.** Translate and Proofread ask the model not to "think" before answering
  (OpenAI `reasoning.effort: none`; Gemini thinking off where the model allows it, otherwise at
  its lowest documented setting — see [Preferences](#preferences)) — faster
  and cheaper for this kind of task.

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
- **An API key** for the provider you pick — OpenAI or a free Gemini key, see below.

## OpenAI key

Create one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) (API usage is
paid). Paste it into **OpenAI API Key** and leave **Provider** on `OpenAI`. The default model is
`gpt-6-luna`; any model you set in **OpenAI Model** must accept reasoning effort `none` (e.g.
GPT-6 Astra does not — the command then says so). Requests are sent with `store: false`, so
OpenAI does not keep your text for later retrieval.

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
  Preferences* / *Get an OpenAI Key* / *Get a Free Key (AI Studio)* right from the error screen)
  and paste the key.

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
| **Provider** | dropdown | `OpenAI` | Which service runs Translate and Proofread: `OpenAI` or `Google Gemini`. |
| **OpenAI API Key** | password | — | Used when Provider = OpenAI — [platform.openai.com/api-keys](https://platform.openai.com/api-keys). |
| **OpenAI Model** | text | `gpt-6-luna` | OpenAI model ID (must accept reasoning effort `none`). |
| **Gemini API Key** | password | — | Used when Provider = Gemini. Free key — [aistudio.google.com](https://aistudio.google.com/app/apikey). |
| **Gemini Model** | text | `gemini-2.5-flash` | Gemini model ID. |
| **Proofread Output Language** | text | `auto` | Proofread commands only: `auto` keeps each text's own language; a language name (e.g. `English`) makes Proofread always produce that language, translating when needed. |
| **Paste Mode** | dropdown | `Plain` | Proofread commands only: how the result replaces the selection — plain match-style `⇧⌘V` (no extra blank lines in Teams/Slack; needs Accessibility), normal `⌘V`, or copy-only. |

**Translate command only** (Raycast shows these on the Translate command's own settings, not
the extension-wide ones):

| Setting | Type | Default | Purpose |
|---|---|---|---|
| **Explanation Language** | text | `Russian` | Language of the explanation block (any: `English`, `German`, …). |
| **Always Explain** | checkbox | `off` | Force the block even for simple phrases (Stream and All at once modes). |
| **Explanation Mode** | dropdown | `Stream` | How the block arrives: `Stream`, `All at once`, or `On demand` — see [below](#explanation-modes). |

The Proofread commands add no preferences of their own — they use the active provider's key and
model.
The model is just a string ID, so when a new version ships you change the preference without
touching code. Free-tier models: `gemini-2.5-flash` (default), `gemini-2.5-flash-lite`,
`gemini-3.5-flash` (more capable, but noticeably pricier on the paid tier).

If the key is empty or invalid, the command shows a clear message naming the active provider,
with a **get a key** action (**Get an OpenAI Key** / **Get a Free Key (AI Studio)**) and **Open
Extension Preferences**. With Provider = OpenAI and no OpenAI key, the message also suggests
switching Provider to Gemini — there is no silent fallback.

Gemini thinking per model (it can't be fully turned off on every model):

- 2.5 Flash / Flash-Lite → `thinkingBudget: 0` (off);
- 2.5 Pro → `thinkingBudget: 128`, its documented minimum (it can't turn thinking off);
- Gemini 3 / 3.5 / 3.6 Flash and 3.1 / 3.5 Flash-Lite → `thinkingLevel: minimal`;
- other Gemini 3+ models (3.7 / 3.8 Flash, 3.1 Pro, …) → `thinkingLevel: low`;
- unrecognized IDs (aliases such as `gemini-flash-latest`) → the model's own default.

Thought tokens count against Gemini's output-token cap, so whenever the model may think, the
request reserves extra room for them (8192 tokens — an estimate) on top of the text's own
budget; a short Proofread can't be starved by thinking.

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
example words/sentences in the studied languages. Hard limits keep it a cheat-sheet: at most
4 meanings, at most 2 examples, synonyms/antonyms on one line, and at most 3 bullets for a
sentence-level block.

The **Always Explain** checkbox forces a block even on simple phrases.

### Explanation modes

- **Stream** (default) — the translation appears as soon as it streams in; the explanation
  streams in below it. **Enter** is always **Copy Result** and `⌘⏎` **Copy Translation Only**;
  pressed before the text they copy is final, they only show a "still translating" toast.
- **All at once** — wait for the full response and render it once (same keys as Stream).
- **On demand** — only the translation is generated. The result screen says *Press ↵ Enter to
  explain this translation*; **Enter** sends a second request that always produces the block
  (the "no block when not needed" rules don't apply — you asked) and streams it in under the
  translation. Enter stays **Explain** throughout — pressed while the translation is still
  arriving, while explaining, or after the block is there, it only shows a toast. Copying moves to
  `⌘⏎` (**Copy Translation Only**) and, once explained, `⌘⇧⏎` (**Copy Result**).

If a response is cut short (output-token cap, content filter, a dropped connection, a timeout)
the screen keeps whatever text already arrived and adds a note saying so; only a failure before
any text arrived shows the error screen. A connection lost mid-response is reported as such,
with a note that the text above is incomplete. There is no total time limit: a request times out
only when no data arrives — up to 60 s for the response to start, then up to 60 s more for its
first chunk (thinking time; both estimates), then 30 s between chunks — so a long, healthy
stream is never cut. Proofread streams the same way, but nothing is
pasted until the whole text has arrived and finished normally.

## Testing the logic without the UI (eval harness)

The prompt logic (the main risk) is validated **headless**, bypassing the Raycast modal — the
core `translate()` / `proofread()` are called directly, with the key from an env var. There are
two suites: `translate` and `proofread`.

```bash
# both suites, every case (Gemini is the eval default provider)
GEMINI_API_KEY=... npm run eval

# the same on OpenAI
OPENAI_API_KEY=... npm run eval -- --provider openai

# the on-demand first request (translation only)
GEMINI_API_KEY=... npm run eval -- --suite translate --part translation

# one suite
GEMINI_API_KEY=... npm run eval -- --suite translate
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
empty-key cases run — the rest are `SKIP`. Env key: `GEMINI_API_KEY` (`--provider gemini`, the
default) or `OPENAI_API_KEY` (`--provider openai`).

The streaming plumbing has its own offline check, no key and no network (`fetch` is stubbed):

```bash
npm run check   # scripts/check-stream.ts
```

It covers the translate reader (every partial chunk, a chunk boundary inside the explanation
marker, missing marker, code fences, "no block" words, old JSON replies), the SSE parser (CRLF,
multi-line data, comments, a UTF-8 character split across chunks), both providers' stream
events, the proofread completeness gate, and the idle timeout.

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
    index.ts           # translate() / explain() / proofread() + provider metadata (labels, key links, models)
    types.ts           # options, results, the shared Backend shape
    openai.ts          # OpenAI Responses API (streamed, effort none, store false)
    gemini.ts          # Gemini streamGenerateContent?alt=sse, thinkingFor(model) + thinking headroom
    limits.ts          # output-token caps
  lib/
    http.ts            # postStream (SSE, first-byte + idle timeouts, no total cap) + status mapping
    sse.ts             # pure server-sent-events parser
    parse.ts           # translate marker reader (streaming-safe) + proofread fence/quote stripping
    errors.ts          # ProviderError discriminated by kind
    markdown.ts        # defangImages: neutralize auto-loading images before rendering
scripts/
  eval.ts              # headless test-case runner (translate + proofread suites, either provider)
  check-stream.ts      # offline checks for parsing, SSE and the completeness gates
```

The key point: the **core (`prompts`/`providers`/`lib`) does not depend on `@raycast/api`** —
the provider receives `apiKey`/`model` as explicit arguments (DI). The same `translate()` /
`proofread()` run in both the UI and the eval harness. Translate streams one plain-text response:
the translation, then — only when a block is warranted — a `<<<EXPLANATION>>>` marker line and
the markdown block. The reader holds back a half-received marker so it is never shown, strips a
fence the model wrapped around its whole reply (code examples inside it stay; if your own text
is a single fenced block, its fences are kept — Translate and Proofread alike), drops a repeated
marker, still understands an old-style JSON reply, and otherwise treats the whole text as the
translation. Once the marker has arrived the translation is final and never changes. A literal
marker in your input is neutralized before it reaches the model, and restored if the model
copies it back.
Proofread returns `{ text }`; it streams too (for the idle timeout), but the text is used only
once it has fully arrived, and any result that did not finish normally (token cap, filter,
refusal, a stream that ended without its end event) is rejected before anything is pasted.

## Security notes

- The API key travels only in a request header (`Authorization` for OpenAI, `x-goog-api-key` for
  Gemini) — never in the URL, logs, or the UI, and it is never committed (`.gitignore` covers
  generated files; preferences hold it).
- OpenAI requests set `store: false`, so the translated / proofread text is not stored for later
  retrieval.
- Model output is treated as untrusted: it is rendered as markdown in `Detail`, and image
  syntax is defanged on every render — including each streamed update — by escaping the `[`
  after `!` (so a preceding backslash can't undo it), and a crafted translation can't auto-load
  a remote image.
- The `<input>…</input>` delimiter limits prompt injection; impact is bounded since the only
  actor is the user translating their own text.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | dev mode with hot reload, registers the command in Raycast |
| `npm run build` | production build (`ray build`) |
| `npm run lint` | `ray lint` (ESLint + Prettier + manifest validation) |
| `npm run fix-lint` | auto-fix lint/formatting |
| `npm run eval` | headless run of the test cases (Gemini by default, `--provider openai`) |
| `npm run check` | offline checks for streaming, parsing and the completeness gates |

> Note: `npm run lint` flags one rule — the `author` field (`makarurbanov`) is not registered
> in the Raycast user registry. It doesn't affect local use; set your own Raycast username
> (Raycast → Settings → Account) for a clean lint.

## License

[MIT](LICENSE).
