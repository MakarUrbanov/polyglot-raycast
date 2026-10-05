/**
 * Defensive parsing of the model's output for both flows.
 *
 * Translate: the model is asked for the translation, then — only when a block
 * is warranted — a line with EXPLANATION_MARK followed by the markdown block.
 * The same reader serves streaming (partial text, `done` = false) and the
 * final result: a half-received mark is held back so it never shows. Models
 * misbehave, so a fence the model wrapped around its reply is stripped (never
 * the author's own fences — see unwrapWhole), an old-style
 * {"translation","explanation"} JSON reply is still understood, and anything
 * else falls back to: whole text = translation, explanation = null.
 *
 * Proofread: the model is asked for the corrected text ONLY — plain text, no
 * JSON, no notes, no fences. Models still occasionally wrap it in fences or
 * quotes, so we strip those before handing the text back.
 */

import { ProviderError } from "./errors";
import type { ProofreadResult, TranslateProgress } from "../providers/types";

/** Separates the translation from the explanation block in the model output. */
export const EXPLANATION_MARK = "<<<EXPLANATION>>>";

/**
 * The mark as it is sent inside user text (the prompts neutralize it there).
 * A model that copies it verbatim gets the original back in the result.
 */
export const DEFUSED_MARK = "<<\\<EXPLANATION>>>";

/** What the model may write after the mark to mean "no block". */
const NO_BLOCK = ["null", "none", "n/a"];

const FENCE = "```";

/** Length of the longest tail of `text` that is a proper prefix of `token`. */
function partialTail(text: string, token: string): number {
  for (let n = Math.min(token.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(token.slice(0, n))) {
      return n;
    }
  }
  return 0;
}

/** A fence line: ``` plus an optional info string (```ts, ```c++). */
const FENCE_LINE = /^```[^`]*$/;

/** A bare fence line — the only kind that can close a block. */
const CLOSE_LINE = /^```\s*$/;

function linesOf(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/, ""));
}

/** An incomplete last line that may still become a fence line. */
function isFenceStart(line: string): boolean {
  return line !== "" && (line.startsWith(FENCE) || FENCE.startsWith(line));
}

/**
 * True when `text` is itself one fenced block: it opens and closes with a fence
 * line. Those fences are the author's, so a reply in the same shape keeps them
 * (the same reasoning stripWrappingQuotes applies to quotes).
 */
export function isFencedBlock(text: string): boolean {
  const lines = linesOf(text.trim());
  return (
    lines.length >= 2 &&
    FENCE_LINE.test(lines[0]) &&
    CLOSE_LINE.test(lines[lines.length - 1])
  );
}

/**
 * The line where the fence opened on line 0 closes, or -1 while it is open. A
 * fence line with an info string always opens a nested block; a bare one closes
 * the innermost open block — so a wrapper may hold tagged code examples.
 */
function closingLine(lines: string[]): number {
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE_LINE.test(lines[i])) {
      continue;
    }
    depth = CLOSE_LINE.test(lines[i]) && depth > 0 ? depth - 1 : depth + 1;
    if (depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Strip a fence the MODEL wrapped around its whole reply: an opening fence line
 * whose matching close is the last line (code blocks inside are fine). `keep`
 * (the input is itself one fenced block) turns it off — those fences are the
 * author's. Streaming applies the same reading to what has arrived: the fence
 * line waits until complete, then stays hidden while the wrapper is still
 * possible; a close followed by more text proves it was the text's own code.
 */
function unwrapWhole(raw: string, done: boolean, keep: boolean): string {
  const text = raw.replace(/^\s+/, "");
  if (keep) {
    return text;
  }
  if (!text.startsWith(FENCE)) {
    return !done && FENCE.startsWith(text) ? "" : text;
  }
  const lines = linesOf(done ? text.trimEnd() : text);
  const complete = done ? lines : lines.slice(0, -1);
  if (complete.length === 0) {
    return ""; // the fence line itself is still arriving
  }
  const close = closingLine(complete);
  if (close !== -1) {
    const after = lines.slice(close + 1).join("\n");
    return after.trim() === "" ? lines.slice(1, close).join("\n") : text;
  }
  if (done) {
    return text; // never closed: not a wrapper
  }
  const tail = lines[lines.length - 1];
  return [...lines.slice(1, -1), ...(isFenceStart(tail) ? [] : [tail])].join(
    "\n",
  );
}

/** Does the text before the mark open a model wrapper still open at the mark? */
function opensWrapper(before: string, keep: boolean): boolean {
  const lines = linesOf(before.replace(/^\s+/, ""));
  return (
    !keep &&
    lines.length > 1 &&
    FENCE_LINE.test(lines[0]) &&
    closingLine(lines) === -1
  );
}

/**
 * The block after the mark of a wrapped reply ends with the wrapper's close:
 * drop it when the block's fence lines are odd (the block's own code examples
 * come in pairs) and it is the last line. While streaming, an incomplete fence
 * line at the tail waits.
 */
function dropWrapperClose(block: string, done: boolean): string {
  const lines = linesOf(block);
  const tail = lines[lines.length - 1];
  const complete = done || !isFenceStart(tail) ? lines : lines.slice(0, -1);
  while (complete.length > 0 && complete[complete.length - 1].trim() === "") {
    complete.pop();
  }
  const fences = complete.filter((line) => FENCE_LINE.test(line)).length;
  const last = complete[complete.length - 1] ?? "";
  if (fences % 2 === 1 && CLOSE_LINE.test(last)) {
    complete.pop();
  }
  return complete.join("\n");
}

/** Put back a mark the prompt neutralized and the model copied verbatim. */
function restoreMark(text: string): string {
  return text.split(DEFUSED_MARK).join(EXPLANATION_MARK);
}

/**
 * Strip a single pair of wrapping quotes the MODEL added. Quotes the author
 * wrote themselves are kept: if the input was already wrapped in the same pair,
 * the wrapping is the author's, not the model's.
 */
function stripWrappingQuotes(text: string, input: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["«", "»"],
  ];
  // Input wrapped in ANY pair = author's quotes; translation may swap glyphs.
  const wraps = ([open, close]: [string, string], t: string) =>
    t.length >= 2 && t.startsWith(open) && t.endsWith(close);
  if (pairs.some((pair) => wraps(pair, input))) {
    return text;
  }
  for (const [open, close] of pairs) {
    if (!wraps([open, close], text)) {
      continue;
    }
    const inner = text.slice(open.length, text.length - close.length);
    // Skip unwrapping if the delimiter recurs inside (a real quoted phrase).
    if (!inner.includes(open) && !inner.includes(close)) {
      return inner.trim();
    }
  }
  return text;
}

/** Extracts the first brace-balanced object (string/escape aware). */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

type Pair = Pick<TranslateProgress, "translation" | "explanation">;

function coerce(parsed: unknown): Pair | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.translation !== "string" || obj.translation.trim() === "") {
    return null;
  }
  const explanation =
    typeof obj.explanation === "string" && obj.explanation.trim() !== ""
      ? obj.explanation.trim()
      : null;
  return { translation: obj.translation.trim(), explanation };
}

function tryParse(candidate: string): Pair | null {
  try {
    return coerce(JSON.parse(candidate));
  } catch {
    return null;
  }
}

/** An old-style {"translation","explanation"} reply, if that is what came. */
function parseLegacyJson(text: string): Pair | null {
  if (!text.includes('"translation"')) {
    return null;
  }
  const direct = tryParse(text);
  if (direct) {
    return direct;
  }
  const extracted = extractFirstObject(text);
  return extracted ? tryParse(extracted) : null;
}

/**
 * The block after the mark at `mark` (-1 = no mark: the whole text). Any
 * further mark the model repeated is dropped, and while streaming a
 * half-received one at the tail is held back.
 */
function blockAfter(
  text: string,
  mark: number,
  done: boolean,
  wrapped = false,
): string {
  const after = mark === -1 ? text : text.slice(mark + EXPLANATION_MARK.length);
  let clean = wrapped ? dropWrapperClose(after, done) : after;
  while (clean.includes(EXPLANATION_MARK)) {
    clean = clean.split(EXPLANATION_MARK).join("");
  }
  const held = done ? 0 : partialTail(clean, EXPLANATION_MARK);
  return restoreMark(clean.slice(0, clean.length - held).trim());
}

/** True while `rest` could still turn out to be a "no block" word. */
function isNoBlock(rest: string, done: boolean): boolean {
  const word = rest.toLowerCase();
  if (word === "") {
    return true;
  }
  return NO_BLOCK.some((token) =>
    done ? token === word : token.startsWith(word),
  );
}

/**
 * Read the translate output — partial (`done` = false, while streaming) or
 * final. The mark, or a half-received mark, never reaches the result. `input`
 * (the user's text) decides whether outer fences are the author's. Once the
 * mark has arrived the translation is final: it depends only on the text
 * before the mark, so later chunks cannot change it.
 */
export function readTranslateOutput(
  raw: string,
  done: boolean,
  input = "",
): TranslateProgress {
  const keep = isFencedBlock(input);
  const lead = (raw ?? "").replace(/^\s+/, "");
  const mark = lead.indexOf(EXPLANATION_MARK);

  if (mark !== -1) {
    const before = lead.slice(0, mark);
    const wrapped = opensWrapper(before, keep);
    const kept = wrapped ? linesOf(before).slice(1).join("\n") : before;
    const translation = restoreMark(kept.trim());
    const rest = blockAfter(lead, mark, done, wrapped);
    if (isNoBlock(rest, done)) {
      return {
        translation,
        explanation: done ? null : "",
        translationDone: true,
      };
    }
    return { translation, explanation: rest, translationDone: true };
  }

  const text = unwrapWhole(lead, done, keep);
  const trimmed = text.trim();
  // Old-style JSON: hold it back while streaming, parse it at the end.
  if (trimmed.startsWith('{"')) {
    const legacy = done ? parseLegacyJson(trimmed) : null;
    if (legacy) {
      return { ...legacy, translationDone: true };
    }
    if (!done) {
      return { translation: "", explanation: null, translationDone: false };
    }
  }
  const held = done ? 0 : partialTail(text, EXPLANATION_MARK);
  const translation = restoreMark(text.slice(0, text.length - held).trim());
  return { translation, explanation: null, translationDone: done };
}

/**
 * Read the explanation-only output (on-demand mode): the markdown block. If the
 * model echoed the mark (or the translation before it), keep what follows it.
 */
export function readExplainOutput(raw: string, done: boolean): string {
  const text = unwrapWhole(raw ?? "", done, false);
  return blockAfter(text, text.indexOf(EXPLANATION_MARK), done);
}

/**
 * Collapse blank lines the model invented. LLMs habitually reformat multiline
 * text into blank-line-separated paragraphs; pasted into chat apps that reads
 * as double spacing. If the input had NO blank line, every blank line in the
 * output is model-added — fold each back into a single newline.
 */
function collapseAddedBlankLines(text: string, input: string): string {
  // CR-aware: a selection may arrive with \r\n while the model emits \n.
  const blankLine = /\r?\n[ \t]*\r?\n/;
  if (blankLine.test(input) || !blankLine.test(text)) {
    return text;
  }
  return text.replace(/(\r?\n)(?:[ \t]*\r?\n)+/g, "$1");
}

export function parseProofreadOutput(
  raw: string,
  input: string,
  label: string,
): ProofreadResult {
  const unwrapped = unwrapWhole((raw ?? "").trim(), true, isFencedBlock(input));
  const cleaned = stripWrappingQuotes(unwrapped.trim(), input);
  const text = collapseAddedBlankLines(cleaned, input);
  if (text === "") {
    // e.g. the model returned only an empty fence — never paste emptiness.
    throw new ProviderError("parse", `${label} returned an empty response.`);
  }
  return { text };
}
