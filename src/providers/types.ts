/**
 * Core provider contracts for the two flows: translate and proofread.
 *
 * The core (prompts/lib/providers) does NOT import `@raycast/api`: providers
 * receive apiKey/model as explicit arguments (DI), so the same `translate()` and
 * `proofread()` run both in the UI and headless in scripts/eval.ts. The app uses
 * Gemini only.
 */

/** Fields every provider call needs, regardless of flow. */
export interface BaseOptions {
  apiKey: string;
  model: string;
  /** Optional external cancellation (the provider adds its own on timeout). */
  signal?: AbortSignal;
}

export interface TranslateOptions extends BaseOptions {
  /** Language of the explanation block (e.g. "Russian"). */
  explanationLanguage: string;
  /** Force the block even for simple phrases (the alwaysExplain preference). */
  alwaysExplain: boolean;
}

export interface ProofreadOptions extends BaseOptions {
  /** When true, rewrite into a polished formal register; otherwise keep the author's register. */
  formal: boolean;
  /** Force the output into this language (e.g. "English"); undefined keeps the input's own language. */
  outputLanguage?: string;
}

export interface TranslateResult {
  /** The translation (protected tokens kept verbatim). */
  translation: string;
  /** Ready-to-render markdown block, or null when the §3 rules say it isn't needed. */
  explanation: string | null;
}

export interface ProofreadResult {
  /** The corrected text, ready to paste back over the selection. */
  text: string;
}
