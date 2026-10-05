/**
 * Headless run of the test cases, bypassing the Raycast UI (OpenAI or Gemini).
 *
 * Validates the prompt LOGIC (the main risk) directly through the core
 * `translate()` / `proofread()`, without the Raycast modal and without
 * preferences. The provider comes from --provider (default gemini); the key
 * from GEMINI_API_KEY or OPENAI_API_KEY to match.
 *
 * Two suites: `translate` (the RU⇄EN flip + explanation block) and `proofread`
 * (in-place correction, casual or formal).
 *
 * Usage:
 *   GEMINI_API_KEY=...  npm run eval                          # both suites
 *   GEMINI_API_KEY=...  npm run eval -- --suite proofread     # one suite
 *   GEMINI_API_KEY=...  npm run eval -- --suite proofread --formal
 *   GEMINI_API_KEY=...  npm run eval -- --suite translate --case 6
 *   npm run eval -- --list                                    # list both suites
 *   OPENAI_API_KEY=...  npm run eval -- --provider openai     # same cases on OpenAI
 *   npm run eval -- --suite proofread --case 11               # "no key" — works keyless
 *
 * Flags: --provider <gemini|openai>  --suite <translate|proofread|all>  --case <N>
 *        --formal  --part <full|translation>  --lang <Language>  --always
 *        --model <id>  --list  --help
 */

import { PROVIDERS, proofread, translate } from "../src/providers";
import type {
  ProofreadOptions,
  ProofreadResult,
  ProviderId,
  TranslateOptions,
  TranslatePart,
  TranslateResult,
} from "../src/providers/types";
import { asProviderError } from "../src/lib/errors";

const ENV_KEYS: Record<ProviderId, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

// --- tiny ANSI helper --------------------------------------------------------
const useColor = process.stdout.isTTY;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);
const cyan = (s: string) => paint("36", s);

// --- argument parsing --------------------------------------------------------
type Suite = "translate" | "proofread" | "all";

interface Args {
  provider: ProviderId;
  suite: Suite;
  /** Translate request kind: full (translation + block) or translation only. */
  part: TranslatePart;
  caseNo?: number;
  lang?: string;
  model?: string;
  formal: boolean;
  always: boolean;
  /** Proofread target language (--to); undefined or "auto" = keep the input's language. */
  to?: string;
  list: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    provider: "gemini",
    suite: "all",
    part: "full",
    formal: false,
    always: false,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valueOf = (inline?: string) => inline ?? argv[++i];
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    switch (flag) {
      case "--provider": {
        const value = valueOf(inline);
        if (value !== "gemini" && value !== "openai") {
          console.error(red(`Unknown provider: ${value} (use gemini|openai)`));
          process.exit(1);
        }
        args.provider = value;
        break;
      }
      case "--part": {
        const value = valueOf(inline);
        if (value !== "full" && value !== "translation") {
          console.error(red(`Unknown part: ${value} (use full|translation)`));
          process.exit(1);
        }
        args.part = value;
        break;
      }
      case "--suite": {
        const value = valueOf(inline);
        if (value !== "translate" && value !== "proofread" && value !== "all") {
          console.error(red(`Unknown suite: ${value} (use translate|proofread|all)`));
          process.exit(1);
        }
        args.suite = value;
        break;
      }
      case "--case":
        args.caseNo = Number(valueOf(inline));
        break;
      case "--lang":
        args.lang = valueOf(inline);
        break;
      case "--model":
        args.model = valueOf(inline);
        break;
      case "--formal":
        args.formal = true;
        break;
      case "--to":
        args.to = valueOf(inline);
        break;
      case "--always":
        args.always = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.error(yellow(`Unknown flag: ${a}`));
    }
  }
  return args;
}

type Check<R> = (r: R) => { ok: boolean; note: string };

// --- translate cases ---------------------------------------------------------
type TranslateSpecial = "emptyKey" | "langFlip";
interface TranslateCase {
  n: number;
  title: string;
  input: string;
  expect: string;
  special?: TranslateSpecial;
  check?: Check<TranslateResult>;
}

const TRANSLATE_CASES: TranslateCase[] = [
  {
    n: 1,
    title: "EN word «set» — polysemy",
    input: "set",
    expect: "RU translation + FULL block: several meanings, examples across different contexts.",
  },
  {
    n: 2,
    title: "RU word «замок» — homonyms",
    input: "замок",
    expect: "EN translation + block separating castle / lock, with examples.",
  },
  {
    n: 3,
    title: "EN idiom «break a leg»",
    input: "break a leg",
    expect: "Translation + block: literal vs idiomatic meaning.",
  },
  {
    n: 4,
    title: "Plain sentence, no pitfalls",
    input: "I will call you tomorrow",
    expect: "RU translation, block ABSENT (explanation === null).",
    check: (r) => ({
      ok: r.explanation === null,
      note: r.explanation === null ? "block absent" : "block present but should not be",
    }),
  },
  {
    n: 5,
    title: "RU ambiguity «Он снял банк»",
    input: "Он снял банк",
    expect: "EN translation + block flags the ambiguity (won the pot / withdrew money / rented the bank).",
  },
  {
    n: 6,
    title: "Mixed text + terms",
    input: "Запушь изменения в main и проверь CI",
    expect: "EN translation; push / main / CI kept verbatim, not mistranslated.",
    check: (r) => {
      const t = r.translation;
      const keptMain = /\bmain\b/.test(t);
      const keptCI = /\bCI\b/.test(t);
      const keptPush = /push/i.test(t);
      const ok = keptMain && keptCI && keptPush;
      return { ok, note: `main:${keptMain ? "✓" : "✗"} CI:${keptCI ? "✓" : "✗"} push:${keptPush ? "✓" : "✗"}` };
    },
  },
  {
    n: 7,
    title: "Technical term «retopology»",
    input: "retopology",
    expect: "Translation/transliteration + explanation (3D term).",
  },
  {
    n: 8,
    title: "Empty API key",
    input: "test",
    expect: "Core throws ProviderError kind=auth naming the active provider (UI leads to preferences). Works without a key.",
    special: "emptyKey",
    check: () => ({ ok: true, note: "" }),
  },
  {
    n: 9,
    title: "Long paragraph, no pitfalls",
    input:
      "Вчера я весь день работал из дома. Утром ответил на письма, потом созвонился с командой и обсудил план на неделю. После обеда написал отчёт и отправил его руководителю, а вечером немного погулял и лёг спать пораньше.",
    expect: "EN translation; block short or absent.",
  },
  {
    n: 10,
    title: "Block language switch (explanationLanguage)",
    input: "set",
    expect: "Same input as case 1, but the block comes out in a different language (flipped from current).",
    special: "langFlip",
  },
];

// --- proofread cases ---------------------------------------------------------
interface ProofreadCase {
  n: number;
  title: string;
  input: string;
  expect: string;
  special?: "emptyKey";
  /** Only meaningful in formal mode — SKIPped without --formal. */
  onlyFormal?: boolean;
  /** Tests a casual-mode contract (style preservation) — SKIPped under --formal. */
  onlyCasual?: boolean;
  /** Tests the fixed-output-language contract — SKIPped without --to. */
  needsTarget?: boolean;
  check?: Check<ProofreadResult>;
}

const hasCyrillic = (t: string) => /[а-яё]/i.test(t);
const hasLatin = (t: string) => /[a-z]/i.test(t);

const PROOFREAD_CASES: ProofreadCase[] = [
  {
    n: 1,
    title: "EN basic fix",
    input: "your right, i think we should of tested it more before we shipped",
    expect: "Corrected English: «your»→«you're», «i»→«I», «should of»→«should have»; wording kept.",
  },
  {
    n: 2,
    title: "Keep informal register",
    input: "hey team, gonna push the fix in a sec, lmk if thats cool",
    expect: "Casual kept — «hey»/«gonna» survive, not turned into «Hello»/«going to».",
    onlyCasual: true,
    check: (r) => {
      const keptHey = /\bhey\b/i.test(r.text);
      const keptGonna = /\bgonna\b/i.test(r.text);
      const ok = keptHey && keptGonna;
      return { ok, note: `hey:${keptHey ? "✓" : "✗"} gonna:${keptGonna ? "✓" : "✗"}` };
    },
  },
  {
    n: 3,
    title: "Lowercase starts kept, i→I",
    input: "i finished the task. lets review it together",
    expect: "«i»→«I» (pronoun), «lets»→«let's», but the lowercase sentence start «lets» stays lowercase.",
    onlyCasual: true,
  },
  {
    n: 4,
    title: "No trailing period added",
    input: "this looks good to me",
    expect: "Unchanged in spirit; NO trailing period added to the final sentence.",
    onlyCasual: true,
    check: (r) => {
      const ok = !/\.\s*$/.test(r.text);
      return { ok, note: ok ? "no trailing period" : "a trailing period was added" };
    },
  },
  {
    n: 5,
    title: "RU fix stays Russian",
    input: "я думаю что мы должны зделать это сегодня вечером",
    expect: "«зделать»→«сделать»; the text stays Russian (not translated to English).",
    check: (r) => {
      const ok = hasCyrillic(r.text);
      return { ok, note: ok ? "stayed Russian" : "no Cyrillic left — likely translated" };
    },
  },
  {
    n: 6,
    title: "EN-dominant + «отправить» fragment",
    input: "please отправить me the report by friday",
    expect: "Fragment folded into English → «send»; no Cyrillic remains.",
    check: (r) => {
      const t = r.text;
      const hasSend = /\bsend\b/i.test(t);
      const noCyrillic = !hasCyrillic(t);
      const ok = hasSend && noCyrillic;
      return { ok, note: `send:${hasSend ? "✓" : "✗"} no-cyrillic:${noCyrillic ? "✓" : "✗"}` };
    },
  },
  {
    n: 7,
    title: "RU loanword «ресёрч» kept",
    input: "мне нужно провести ресёрч перед встречей с командой",
    expect: "Stays Russian; loanword «ресёрч» kept in Cyrillic, not replaced with a Latin «research».",
    onlyCasual: true,
    check: (r) => {
      const t = r.text;
      const keptLoanword = /рес[её]рч/i.test(t);
      const stayedRussian = hasCyrillic(t);
      const noLatin = !hasLatin(t);
      const ok = keptLoanword && stayedRussian && noLatin;
      return {
        ok,
        note: `loanword:${keptLoanword ? "✓" : "✗"} russian:${stayedRussian ? "✓" : "✗"} no-latin:${noLatin ? "✓" : "✗"}`,
      };
    },
  },
  {
    n: 8,
    title: "Protected terms survive edits",
    input: "we needs to push this too main and than check the CI before we merge",
    expect: "Prose errors fixed; protected terms main / CI / push kept verbatim.",
    check: (r) => {
      const t = r.text;
      const keptMain = /\bmain\b/.test(t);
      const keptCI = /\bCI\b/.test(t);
      const keptPush = /push/i.test(t);
      const ok = keptMain && keptCI && keptPush;
      return { ok, note: `main:${keptMain ? "✓" : "✗"} CI:${keptCI ? "✓" : "✗"} push:${keptPush ? "✓" : "✗"}` };
    },
  },
  {
    n: 9,
    title: "Formal rewrite (formal mode only)",
    input: "hey, can u send me the report asap? thx",
    expect: "Formal register: polished, professional English; meaning preserved, nothing added.",
    onlyFormal: true,
  },
  {
    n: 10,
    title: "Already-correct text unchanged",
    input: "The meeting is scheduled for 3 PM tomorrow.",
    expect: "Returned essentially unchanged (near-unchanged is fine).",
  },
  {
    n: 11,
    title: "Empty API key",
    input: "test",
    expect: "Core throws ProviderError kind=auth naming the active provider (HUD leads to preferences). Works without a key.",
    special: "emptyKey",
    check: () => ({ ok: true, note: "" }),
  },
  {
    n: 12,
    title: "Line breaks preserved, no blank lines added",
    input: "fixed the login bug\nalso added two more test\nupdated the readme accordingly",
    expect: "Three lines in, three lines out; no blank lines between them; «test»→«tests».",
    check: (r) => {
      const sameLines = r.text.split("\n").length === 3;
      const fixed = /\btests\b/i.test(r.text);
      const ok = sameLines && fixed;
      return { ok, note: `3-lines:${sameLines ? "✓" : "✗"} tests:${fixed ? "✓" : "✗"}` };
    },
  },
  {
    n: 13,
    title: "Jira markup kept verbatim",
    input: "h1. Summary\n* we needs to update the login flow\n* see [docs|https://example.com/spec] for detail",
    expect: "«needs»→«need», «detail»→«details»; h1. heading, * bullets and the [docs|…] link untouched.",
    check: (r) => {
      const t = r.text;
      const keptHeading = /^h1\. /m.test(t);
      const keptBullets = (t.match(/^\* /gm) ?? []).length === 2;
      const keptLink = t.includes("[docs|https://example.com/spec]");
      const fixed = /\bwe need\b/i.test(t) && /\bdetails\b/i.test(t);
      const ok = keptHeading && keptBullets && keptLink && fixed;
      return {
        ok,
        note: `h1:${keptHeading ? "✓" : "✗"} bullets:${keptBullets ? "✓" : "✗"} link:${keptLink ? "✓" : "✗"} fixed:${fixed ? "✓" : "✗"}`,
      };
    },
  },
  {
    n: 14,
    title: "No em dash introduced",
    input: "the fix is simple - just restart the service and check the logs",
    expect: "The author's hyphen is not upgraded: no em dash (—) and no double hyphen (--) in the output.",
    check: (r) => {
      const ok = !r.text.includes("—") && !r.text.includes("--");
      return { ok, note: ok ? "no em dash / --" : "an em dash or -- was introduced" };
    },
  },
  {
    n: 15,
    title: "Author's paragraph break kept, none added",
    input: "the team has finished the migration\n\nnext week we plans to update the docs",
    expect:
      "Input HAS a blank line, so the code-level guard is off — the PROMPT must keep exactly one paragraph break; «plans»→«plan».",
    check: (r) => {
      const paragraphs = r.text.split(/\n[ \t]*\n/).length === 2;
      const fixed = /\bwe plan\b/i.test(r.text);
      const ok = paragraphs && fixed;
      return { ok, note: `2-paragraphs:${paragraphs ? "✓" : "✗"} plan:${fixed ? "✓" : "✗"}` };
    },
  },
  {
    n: 16,
    title: "Target language: RU in → EN out, register kept",
    input: "привет! я задержусь минут на 15, сорри за это",
    expect: "With --to English: casual English out (no Cyrillic), not formalized into «Hello».",
    needsTarget: true,
    onlyCasual: true,
    check: (r) => {
      const noCyrillic = !hasCyrillic(r.text);
      const casualKept = !/^\s*hello\b/i.test(r.text);
      const ok = noCyrillic && casualKept;
      return { ok, note: `english:${noCyrillic ? "✓" : "✗"} casual:${casualKept ? "✓" : "✗"}` };
    },
  },
  {
    n: 17,
    title: "Target language: EN in stays EN, just proofread",
    input: "she do not have access to the dashboard",
    expect: "With --to English: normal proofread («do not»→«does not»), nothing translated.",
    needsTarget: true,
    check: (r) => {
      const fixed = /\bdoes not have\b|\bdoesn't have\b/i.test(r.text);
      const noCyrillic = !hasCyrillic(r.text);
      const ok = fixed && noCyrillic;
      return { ok, note: `fixed:${fixed ? "✓" : "✗"} english:${noCyrillic ? "✓" : "✗"}` };
    },
  },
  {
    n: 18,
    title: "Target language + formal: RU in → formal EN out",
    input: "привет, скинь плиз отчет когда будет готов",
    expect: "With --to English --formal: polished formal English (no Cyrillic), register raised, meaning kept.",
    needsTarget: true,
    onlyFormal: true,
    check: (r) => {
      const noCyrillic = !hasCyrillic(r.text);
      return { ok: noCyrillic, note: noCyrillic ? "english out (register: eyeball)" : "Cyrillic left in output" };
    },
  },
  {
    n: 19,
    title: "Word order: trailing adverb calque fixed",
    input: "we're working with Sergey on keeping them up to date always",
    expect:
      "Russian-style trailing «always» moved before the verb: «on always keeping them up to date» (or «…to make sure they're always up to date»). Not left at the end.",
    check: (r) => {
      const t = r.text.toLowerCase();
      const hasAlways = /\balways\b/.test(t);
      const notTrailing = !/always[\s.!?]*$/.test(t.trim());
      const alwaysIdx = t.indexOf("always");
      const upToDateIdx = t.indexOf("up to date");
      const movedEarlier = hasAlways && (upToDateIdx === -1 || alwaysIdx < upToDateIdx);
      const ok = hasAlways && notTrailing && movedEarlier;
      return {
        ok,
        note: `always:${hasAlways ? "✓" : "✗"} not-trailing:${notTrailing ? "✓" : "✗"} moved:${movedEarlier ? "✓" : "✗"}`,
      };
    },
  },
  {
    n: 20,
    title: "Word order: natural sentence left intact",
    input: "on Friday we shipped the release, and the team celebrated afterward",
    expect:
      "Already-natural English; word order untouched. «afterward» stays at the end (correct here, unlike a calqued trailing adverb) and «on Friday» stays fronted.",
    onlyCasual: true,
    check: (r) => {
      const t = r.text.toLowerCase();
      const fridayFront = t.indexOf("friday") !== -1 && t.indexOf("friday") < t.indexOf("shipped");
      const afterwardEnd = t.indexOf("afterward") > t.indexOf("celebrated");
      const ok = fridayFront && afterwardEnd;
      return { ok, note: `friday-front:${fridayFront ? "✓" : "✗"} afterward-end:${afterwardEnd ? "✓" : "✗"}` };
    },
  },
  {
    n: 21,
    title: "Word order: RU flexible order not normalized",
    input: "вчера весь день я работал из дома, а вечером немного погулял",
    expect:
      "Russian permits this fronted order; leave it. Stays Russian, «вчера» stays fronted — do NOT normalize to a neutral subject-verb order.",
    onlyCasual: true,
    check: (r) => {
      const t = r.text.toLowerCase();
      const stayedRussian = hasCyrillic(t);
      const fronted = t.indexOf("вчера") !== -1 && t.indexOf("вчера") < t.indexOf("работал");
      const ok = stayedRussian && fronted;
      return { ok, note: `russian:${stayedRussian ? "✓" : "✗"} вчера-front:${fronted ? "✓" : "✗"}` };
    },
  },
];

// --- printing ----------------------------------------------------------------
function printTranslateResult(r: TranslateResult) {
  console.log(bold("Translation: ") + r.translation);
  if (r.explanation) {
    console.log(bold("Block:"));
    console.log(
      r.explanation
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
    );
  } else {
    console.log(bold("Block: ") + dim("[no block]"));
  }
  if (r.cutShort) {
    console.log(yellow(`Cut short: ${r.cutShort}`));
  }
}

function printProofreadResult(r: ProofreadResult) {
  console.log(bold("Corrected: ") + r.text);
}

function verdict(ok: boolean, note: string) {
  console.log((ok ? green("AUTO-CHECK: PASS") : red("AUTO-CHECK: FAIL")) + (note ? dim(` — ${note}`) : ""));
}

function caseHeader(suite: string, n: number, title: string, input: string, expect: string) {
  console.log("");
  console.log(cyan("─".repeat(70)));
  console.log(cyan(`${suite} CASE ${n}. `) + bold(title));
  console.log(dim("Input:    ") + JSON.stringify(input));
  console.log(dim("Expected: ") + expect);
}

function flipLang(lang: string): string {
  return lang.trim().toLowerCase() === "russian" ? "English" : "Russian";
}

// --- runners -----------------------------------------------------------------
/** The empty-key case passes on kind=auth AND a message naming the provider. */
function authVerdict(e: unknown, provider: ProviderId) {
  const err = asProviderError(e);
  const named = err.message.includes(PROVIDERS[provider].label);
  verdict(err.kind === "auth" && named, `kind=${err.kind}: ${err.message}`);
}

async function runTranslateCase(c: TranslateCase, base: TranslateOptions, hasKey: boolean, part: TranslatePart) {
  caseHeader("TRANSLATE", c.n, c.title, c.input, c.expect);

  // The "empty key" case does not need a real key.
  if (c.special === "emptyKey") {
    try {
      await translate(c.input, { ...base, apiKey: "" });
      verdict(false, "expected an auth error, but the request went through");
    } catch (e) {
      authVerdict(e, base.provider);
    }
    return;
  }

  if (!hasKey) {
    console.log(yellow(`SKIP: no key in env (${ENV_KEYS[base.provider]}) — live request skipped.`));
    return;
  }

  const opts: TranslateOptions =
    c.special === "langFlip" ? { ...base, explanationLanguage: flipLang(base.explanationLanguage) } : base;
  if (c.special === "langFlip") {
    console.log(dim(`(explanationLanguage: ${base.explanationLanguage} → ${opts.explanationLanguage})`));
  }

  try {
    const started = Date.now();
    const r = await translate(c.input, opts, part);
    const ms = Date.now() - started;
    printTranslateResult(r);
    console.log(dim(`(${ms} ms)`));
    if (c.check) {
      const v = c.check(r);
      verdict(v.ok, v.note);
    }
  } catch (e) {
    const err = asProviderError(e);
    console.log(red(`ERROR: kind=${err.kind} — ${err.message}`));
  }
}

async function runProofreadCase(c: ProofreadCase, base: ProofreadOptions, hasKey: boolean) {
  caseHeader("PROOFREAD", c.n, c.title, c.input, c.expect);

  if (c.special === "emptyKey") {
    try {
      await proofread(c.input, { ...base, apiKey: "" });
      verdict(false, "expected an auth error, but the request went through");
    } catch (e) {
      authVerdict(e, base.provider);
    }
    return;
  }

  if (c.onlyFormal && !base.formal) {
    console.log(yellow("SKIP: formal-only case — re-run with --formal."));
    return;
  }

  if (c.onlyCasual && base.formal) {
    console.log(yellow("SKIP: casual-only case — re-run without --formal."));
    return;
  }

  if (c.needsTarget && !base.outputLanguage) {
    console.log(yellow("SKIP: needs a target language — re-run with --to English."));
    return;
  }

  if (!hasKey) {
    console.log(yellow(`SKIP: no key in env (${ENV_KEYS[base.provider]}) — live request skipped.`));
    return;
  }

  try {
    const started = Date.now();
    const r = await proofread(c.input, base);
    const ms = Date.now() - started;
    printProofreadResult(r);
    console.log(dim(`(${ms} ms, mode: ${base.formal ? "formal" : "casual"})`));
    if (c.check) {
      const v = c.check(r);
      verdict(v.ok, v.note);
    }
  } catch (e) {
    const err = asProviderError(e);
    console.log(red(`ERROR: kind=${err.kind} — ${err.message}`));
  }
}

// --- list / help -------------------------------------------------------------
function printList() {
  console.log(bold("Translate suite:"));
  for (const c of TRANSLATE_CASES) {
    console.log(`  ${String(c.n).padStart(2)}. ${c.title}`);
  }
  console.log("");
  console.log(bold("Proofread suite:"));
  for (const c of PROOFREAD_CASES) {
    const tags = [
      c.onlyFormal ? " (--formal only)" : "",
      c.onlyCasual ? " (casual only)" : "",
      c.needsTarget ? " (--to only)" : "",
    ].join("");
    console.log(`  ${String(c.n).padStart(2)}. ${c.title}${dim(tags)}`);
  }
}

function printHelp() {
  console.log(`Polyglot eval — run the test cases without the Raycast UI (OpenAI or Gemini).

Flags:
  --provider <name>    gemini | openai (default: gemini); key from ${ENV_KEYS.gemini} / ${ENV_KEYS.openai}
  --suite <name>       translate | proofread | all (default: all)
  --case <N>           a single case number within the selected suite(s)
  --formal             proofread suite runs in formal mode (enables case 9, skips casual-only cases)
  --to <Language>      proofread target language (e.g. English); default auto = keep the input's language
  --part <name>        translate request: full (translation + block) | translation (on-demand first request)
  --lang <Language>    translate block language (default: Russian)
  --always             translate alwaysExplain = true
  --model <id>         override the provider's model (both suites)
  --list               list the cases of both suites
  --help               this help

Key via env: ${ENV_KEYS.gemini} (gemini) or ${ENV_KEYS.openai} (openai)
Examples:
  ${ENV_KEYS.gemini}=xxx npm run eval -- --suite translate --case 6
  ${ENV_KEYS.gemini}=xxx npm run eval -- --suite proofread --formal
  ${ENV_KEYS.gemini}=xxx npm run eval -- --suite proofread --to English
  ${ENV_KEYS.openai}=xxx npm run eval -- --provider openai --suite translate --part translation
  npm run eval -- --suite proofread --case 11   # empty-key case, works keyless`);
}

// --- selection ---------------------------------------------------------------
function select<T extends { n: number }>(cases: T[], caseNo?: number): T[] {
  return caseNo ? cases.filter((c) => c.n === caseNo) : cases;
}

interface Bases {
  translate: TranslateOptions;
  proofread: ProofreadOptions;
}

function buildBases(args: Args, apiKey: string): Bases {
  const provider = args.provider;
  const model = args.model ?? PROVIDERS[provider].defaultModel;
  const toLang = args.to?.trim();
  return {
    translate: {
      provider,
      apiKey,
      model,
      explanationLanguage: args.lang ?? process.env.POLYGLOT_EXPLANATION_LANGUAGE ?? "Russian",
      alwaysExplain: args.always,
    },
    proofread: {
      provider,
      apiKey,
      model,
      formal: args.formal,
      outputLanguage: toLang && !/^auto$/i.test(toLang) ? toLang : undefined,
    },
  };
}

function printHeader(args: Args, bases: Bases, hasKey: boolean, wantTranslate: boolean, wantProofread: boolean) {
  console.log(bold(`Polyglot eval — ${PROVIDERS[args.provider].label}`));
  console.log(dim("Suite:        ") + args.suite);
  console.log(dim("Model:        ") + bases.translate.model);
  if (wantTranslate) {
    console.log(dim("Block lang:   ") + bases.translate.explanationLanguage);
    console.log(dim("alwaysExplain:") + ` ${bases.translate.alwaysExplain}`);
    console.log(dim("Part:         ") + args.part);
  }
  if (wantProofread) {
    console.log(dim("Proofread:    ") + (args.formal ? "formal" : "casual"));
    console.log(dim("Target lang:  ") + (bases.proofread.outputLanguage ?? "auto"));
  }
  console.log(dim("Key:          ") + (hasKey ? green("set") : red(`missing (${ENV_KEYS[args.provider]})`)));
  if (!hasKey) {
    console.log(yellow("Without a key only the empty-key cases run; the rest are SKIP."));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.list) {
    printList();
    return;
  }

  const apiKey = (process.env[ENV_KEYS[args.provider]] ?? "").trim();
  const hasKey = apiKey !== "";
  const bases = buildBases(args, apiKey);
  const wantTranslate = args.suite === "translate" || args.suite === "all";
  const wantProofread = args.suite === "proofread" || args.suite === "all";

  printHeader(args, bases, hasKey, wantTranslate, wantProofread);

  const translateSelected = wantTranslate ? select(TRANSLATE_CASES, args.caseNo) : [];
  const proofreadSelected = wantProofread ? select(PROOFREAD_CASES, args.caseNo) : [];
  if (args.caseNo && translateSelected.length === 0 && proofreadSelected.length === 0) {
    console.error(red(`Case ${args.caseNo} not found in the selected suite(s).`));
    process.exit(1);
  }

  for (const c of translateSelected) {
    await runTranslateCase(c, bases.translate, hasKey, args.part);
  }
  for (const c of proofreadSelected) {
    await runProofreadCase(c, bases.proofread, hasKey);
  }

  console.log("");
  console.log(cyan("─".repeat(70)));
  console.log(green("Done."));
}

void main();
