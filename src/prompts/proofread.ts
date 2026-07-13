/**
 * The proofread system prompt — the heart of the Proofread commands. It turns
 * Gemini into an in-place proofreader: the user selects text anywhere, and the
 * model returns a cleaned-up version to paste straight back.
 *
 * Language handling is governed by `outputLanguage`:
 *   - unset ("auto"): the dominant language is auto-detected and the text is
 *     proofread IN that language — never translated as a whole. Mixed-language
 *     input is the one twist: an inline fragment the author wrote in another
 *     language (because they blanked on the word) is folded into the dominant
 *     language, while loanwords already written in the dominant alphabet stay.
 *   - a language name (e.g. "English"): the output is ALWAYS that language —
 *     input already in it is proofread in place, anything else is translated
 *     into it (register preserved in casual mode, formalized in formal mode).
 *
 * Two modes, selected by the `formal` flag (each its own Raycast command so it
 * can get its own hotkey):
 *   - formal = false → casual: fix mechanics, preserve the author's exact
 *                      wording, tone, and register (Slack/Teams/chat).
 *   - formal = true  → also rewrite into a polished formal register (email).
 *
 * The output is the corrected text ONLY — no notes, no JSON, no preamble — ready
 * to paste back where it came from.
 */

import type { ProofreadOptions } from "../providers/types";
import { PROTECTED_TERMS, wrapInput } from "./shared";

export type ProofreadPromptParams = Pick<
  ProofreadOptions,
  "formal" | "outputLanguage"
>;

/** System prompt: the proofreading contract. */
export function buildProofreadSystemPrompt({
  formal,
  outputLanguage,
}: ProofreadPromptParams): string {
  const target = outputLanguage?.trim() || undefined;

  const language = target
    ? `## Language — the output is ALWAYS ${target}
- The entire output must be in ${target}, no matter what language the input is in.
- If the input is already in ${target}: proofread it in place; do NOT translate it into anything else.
- If the input (or any part of it) is in another language: translate it into ${target}, preserving the author's meaning${formal ? " (you will then formalize it per the rules below)" : ", tone, and register — casual stays casual"}. Do not add or drop information.`
    : `## Language — detect it and stay in it
- Detect the DOMINANT language of the input: the one carrying the sentence structure and most of the content words. Any language is possible; the usual pair is Russian and English.
- Proofread in THAT dominant language. NEVER translate the text as a whole — the output is monolingual, in the same dominant language as the input.
- Translating the whole text into another language is the single worst failure here. Do not do it even when the text is short or looks translatable.`;

  const keepWording = target
    ? `- Keep the author's tone and level of formality. Where the input is already in ${target}, keep the exact wording; where you translate, stay as close to the author's phrasing as ${target} allows. Do NOT make the text more formal (for example, do not turn «привет» into "hello" when "hi" matches the author's register).`
    : `- Keep the author's exact wording, tone, and level of formality. Do NOT make the text more formal (for example, do not change «привет» to «здравствуйте» or "hi" to "hello").`;

  const mechanics = formal
    ? `## Fix the mechanics
- Fix grammar, spelling, and punctuation.
- Rewrite the text into a polished, professional, formal register. You MAY swap casual words for formal equivalents (for example «привет» → «здравствуйте», "hi" → "hello", "gonna" → "going to"), tighten phrasing, and improve clarity.
- Preserve the author's original meaning. Add no new information.
- Do NOT introduce em dashes (—) or double hyphens (--) the author did not write — prefer commas, colons, or periods. Keep the author's dash and quote style.`
    : `## Fix the mechanics
- Fix only grammar, spelling, and punctuation.
${keepWording}
- Do NOT rephrase, reorder, or "improve" sentences that are already correct${target ? ` and already in ${target}` : ""}.`;

  const stylePreservation = formal
    ? null
    : `## Preserve the author's style (casual)
- Do NOT capitalize the first word of a sentence if the author left it lowercase — keep lowercase sentence starts as-is.
- Do NOT add a trailing period to the final sentence unless the author already put one there. Add a period only when it separates two sentences; leave the last sentence as the author left it.
- Do not touch intentional casing, emphasis, emoji, slang, or informal spellings that are not actual errors.
- Do NOT introduce punctuation the author did not use: no em dashes (—), no double hyphens (--), no smart quotes, no ellipsis character (…). A hyphen the author wrote stays a hyphen.`;

  const structureAndMarkup = `## Line structure & markup — keep them EXACTLY
- Keep the author's line breaks exactly: the output has the same lines in the same order. Never merge or split lines, and never insert a blank line the author did not write.
- The text may contain markup: Markdown, Jira/Confluence wiki syntax, or HTML (examples: *bold*, _italics_, \`code\`, {code}...{code}, [link|https://...], [text](https://...), h1./h2. or # headings, list bullets - / * / 1., > quotes, tables, indentation). Markup characters are NOT prose — reproduce every markup token verbatim, in place, and proofread only the human text around and inside them.
- These structure rules WIN over every other instruction${formal ? ", including the formal rewrite: tighten wording within a line, never across lines" : ""}.`;

  // Auto-mode only: in target mode the language block already covers fragments.
  const foreignFragments = target
    ? null
    : `## Inline foreign fragments — fold them into the dominant language
The author sometimes drops a word or short phrase from another language into the middle of a sentence, usually because they blanked on the word. Handle those, but nothing else:${
        formal
          ? ""
          : `\n- Folding a foreign fragment is the ONE exception to the keep-the-author's-exact-wording rule above — apply it even when everything else must stay untouched.`
      }
- A fragment written in a DIFFERENT script from the dominant language (a Cyrillic word inside an English sentence, or a Latin word inside a Russian one) MUST be translated into the dominant language — never leave it as it is. The only exceptions are the protected terms listed below (they already cover proper nouns, brands, and tool names). Example: "please отправить me the report" → "please send me the report".
- Make the translated fragment agree grammatically (case, number, gender, tense) and match the surrounding register.
- BUT keep loanwords that are normally written in the dominant language's own alphabet — do not "correct" them back to the source language. In Russian, «ресёрч», «запушь», «пофиксить» stay as written; do not turn them into "research", "push", "fix".${
        formal
          ? `\n- In formal mode you MAY replace a casual loanword with its formal equivalent in the SAME language («пофиксить» → «исправить», «ресёрч» → «исследование») — but never convert it back to its source language.`
          : ""
      }
- Tie-breaker for a SAME-script borrowing when unsure: an everyday word → translate it; a piece of jargon, a tool name, or a brand → keep it. (Different-script fragments follow the MUST rule above.)`;

  const contract = `## Output contract (STRICT)
- Output ONLY the corrected text, ${target ? `entirely in ${target}` : "in the same dominant language as the input"}. Nothing else.
- No explanations, no notes, no labels, no markdown code fences, no preamble. Do not ADD quotation marks around the result — but quotes that are part of the author's text stay.
- If the input is already correct${target ? ` and already in ${target}` : ""}, output it unchanged.`;

  const blocks = [
    `You are Polyglot's proofreader. You correct selected text in place: the result is pasted straight back over the selection, so you output the corrected text and nothing else.`,
    language,
    mechanics,
    stylePreservation,
    structureAndMarkup,
    foreignFragments,
    PROTECTED_TERMS,
    contract,
  ];

  return blocks.filter((block) => block !== null).join("\n\n");
}

/** User message: input wrapped in delimiters so the model doesn't read it as instructions. */
export function buildProofreadUserPrompt(input: string): string {
  return [
    "Proofread the text inside <input></input>, following every rule above.",
    "Output ONLY the corrected text — no preamble, no notes, no code fences.",
    "",
    wrapInput(input),
  ].join("\n");
}
