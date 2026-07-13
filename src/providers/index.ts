/**
 * Core entry points: `translate()` and `proofread()`. Each validates input/key
 * and delegates to Gemini, the app's only provider. The gemini.ts layer is kept
 * as a seam: re-adding other providers means restoring their modules from git
 * history plus a dispatcher.
 */

import { ProviderError } from "../lib/errors";
import { proofreadWithGemini, translateWithGemini } from "./gemini";
import type {
  ProofreadOptions,
  ProofreadResult,
  TranslateOptions,
  TranslateResult,
} from "./types";

/** Default Gemini model — fallback when the preference field is empty. */
export const DEFAULT_MODEL = "gemini-2.5-flash";

/** Shared guard for both flows: reject empty input and a missing key. */
function assertReady(input: string, apiKey: string): string {
  const text = input.trim();
  if (text === "") {
    throw new ProviderError("empty", "Empty input — nothing to process.");
  }
  if (apiKey.trim() === "") {
    throw new ProviderError(
      "auth",
      "No Gemini API key set. It's free — get one at aistudio.google.com (Get API key).",
    );
  }
  return text;
}

export async function translate(
  input: string,
  opts: TranslateOptions,
): Promise<TranslateResult> {
  const text = assertReady(input, opts.apiKey);
  return translateWithGemini(text, opts);
}

export async function proofread(
  input: string,
  opts: ProofreadOptions,
): Promise<ProofreadResult> {
  const text = assertReady(input, opts.apiKey);
  return proofreadWithGemini(text, opts);
}

export type {
  ProofreadOptions,
  ProofreadResult,
  TranslateOptions,
  TranslateResult,
} from "./types";
