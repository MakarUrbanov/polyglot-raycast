/**
 * Core provider contracts for the two flows: translate and proofread.
 *
 * The core (prompts/lib/providers) does NOT import `@raycast/api`: providers
 * receive provider/apiKey/model as explicit arguments (DI), so the same
 * `translate()` and `proofread()` run both in the UI and headless in
 * scripts/eval.ts. Two providers: OpenAI and Gemini.
 */

/** Which service runs the request (the `provider` preference). */
export type ProviderId = "openai" | "gemini";

/** Fields every provider call needs, regardless of flow. */
export interface BaseOptions {
  provider: ProviderId;
  apiKey: string;
  model: string;
  /** Optional external cancellation (the provider adds its own on timeout). */
  signal?: AbortSignal;
}

/** A partial translate result while the response is still streaming. */
export interface TranslateProgress {
  translation: string;
  /** The explanation received so far, or null when none has started. */
  explanation: string | null;
  /** True once the translation is final (the explanation part has begun). */
  translationDone: boolean;
}

export interface TranslateOptions extends BaseOptions {
  /** Language of the explanation block (e.g. "Russian"). */
  explanationLanguage: string;
  /** Force the block even for simple phrases (the alwaysExplain preference). */
  alwaysExplain: boolean;
  /** Streaming callback: called with the latest partial result. */
  onUpdate?: (progress: TranslateProgress) => void;
}

/**
 * What a translate request asks for: the translation plus the explanation
 * block per the rules ("full"), or the translation alone ("translation").
 */
export type TranslatePart = "full" | "translation";

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
  /** Null on a normal finish; otherwise why the model stopped early. */
  cutShort: string | null;
}

export interface ExplainResult {
  /** The explanation block (markdown). */
  explanation: string;
  /** Null on a normal finish; otherwise why the model stopped early. */
  cutShort: string | null;
}

export interface ProofreadResult {
  /** The corrected text, ready to paste back over the selection. */
  text: string;
}

/** How a model response ended, normalized across providers. */
export type Finish = "done" | "truncated" | "blocked" | "other";

export interface CallResult {
  text: string;
  finish: Finish;
  /** The provider's raw reason (e.g. "MAX_TOKENS", "max_output_tokens"). */
  reason?: string;
}

/** One model call, shared shape for both providers. */
export interface CallArgs {
  system: string;
  user: string;
  maxTokens: number;
  opts: BaseOptions;
}

/**
 * The provider-specific transport behind translate/explain/proofread. Every
 * call streams (idle timeout, no total cap); proofread just ignores the deltas
 * and gates on the finish.
 */
export interface Backend {
  /** Streaming call; `onText` receives each text delta. */
  stream: (
    args: CallArgs,
    onText: (delta: string) => void,
  ) => Promise<CallResult>;
}
