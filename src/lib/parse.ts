/**
 * Defensive parsing of the model's output for both flows.
 *
 * Translate: the model is asked for strictly {"translation": string,
 * "explanation": string|null} with no preamble and no ``` fences. Models
 * misbehave, so we strip fences, try JSON.parse, try to extract the first
 * brace-balanced {...}, then fall back to: whole text = translation,
 * explanation = null.
 *
 * Proofread: the model is asked for the corrected text ONLY — plain text, no
 * JSON, no notes, no fences. Models still occasionally wrap it in fences or
 * quotes, so we strip those before handing the text back.
 */

import { ProviderError } from "./errors";
import type { ProofreadResult, TranslateResult } from "../providers/types";

/** Strip a single wrapping ```/```json code fence if the model added one. */
function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Strip a fence ONLY when it wraps the entire output. The proofread result may
 * legitimately contain code blocks from the user's own text, so matching a
 * fence anywhere (as the translate parser does) would discard the prose around
 * it — and that fragment would then be pasted over the whole selection.
 */
function stripWholeFence(text: string): string {
  const fenced = text.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i);
  if (fenced && !fenced[1].includes("```")) {
    return fenced[1].trim();
  }
  return text;
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
  for (const [open, close] of pairs) {
    if (text.length < 2 || !text.startsWith(open) || !text.endsWith(close)) {
      continue;
    }
    if (input.startsWith(open) && input.endsWith(close)) {
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

function coerce(parsed: unknown): TranslateResult | null {
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

function tryParse(candidate: string): TranslateResult | null {
  try {
    return coerce(JSON.parse(candidate));
  } catch {
    return null;
  }
}

export function parseTranslateOutput(raw: string): TranslateResult {
  const text = (raw ?? "").trim();
  const cleaned = stripCodeFences(text);

  const direct = tryParse(cleaned);
  if (direct) {
    return direct;
  }

  const extracted = extractFirstObject(cleaned);
  if (extracted) {
    const fromExtract = tryParse(extracted);
    if (fromExtract) {
      return fromExtract;
    }
  }

  // Fallback: the model ignored the format — show the fence-stripped text as-is.
  return { translation: cleaned || text, explanation: null };
}

export function parseProofreadOutput(
  raw: string,
  input: string,
): ProofreadResult {
  const text = stripWrappingQuotes(stripWholeFence((raw ?? "").trim()), input);
  if (text === "") {
    // e.g. the model returned only an empty fence — never paste emptiness.
    throw new ProviderError("parse", "Gemini returned an empty response.");
  }
  return { text };
}
