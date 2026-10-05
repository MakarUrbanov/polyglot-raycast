/**
 * Core entry points: `translate()`, `explain()` and `proofread()`. Each
 * validates input/key, builds the prompt, and runs it on the provider picked by
 * `opts.provider` (OpenAI or Gemini) through the shared Backend shape. The
 * flow logic — parsing, the proofread completeness gate — lives here once.
 */

import { ProviderError } from "../lib/errors";
import {
  parseProofreadOutput,
  readExplainOutput,
  readTranslateOutput,
} from "../lib/parse";
import {
  buildProofreadSystemPrompt,
  buildProofreadUserPrompt,
} from "../prompts/proofread";
import {
  buildExplainSystemPrompt,
  buildExplainUserPrompt,
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
} from "../prompts/translate";
import { gemini } from "./gemini";
import { outputCap, translateCap, translationOnlyCap } from "./limits";
import { openai } from "./openai";
import type {
  Backend,
  CallResult,
  ExplainResult,
  ProofreadOptions,
  ProofreadResult,
  ProviderId,
  TranslateOptions,
  TranslatePart,
  TranslateResult,
} from "./types";

/** Per-provider facts the UI and eval need (names, links, default model). */
export interface ProviderInfo {
  /** Service name shown to the user. */
  label: string;
  /** Fallback when the model preference is empty. */
  defaultModel: string;
  /** Where to get a key. */
  keyUrl: string;
  /** Title of the "get a key" action. */
  keyAction: string;
  /** One-line "how to get a key" text. */
  keyHint: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-6-luna",
    keyUrl: "https://platform.openai.com/api-keys",
    keyAction: "Get an OpenAI Key",
    keyHint: "Create one at platform.openai.com/api-keys",
  },
  gemini: {
    label: "Gemini",
    defaultModel: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyAction: "Get a Free Key (AI Studio)",
    keyHint: "It's free — get one at aistudio.google.com (Get API key)",
  },
};

/** Default provider — the `provider` preference's default. */
export const DEFAULT_PROVIDER: ProviderId = "openai";

const BACKENDS: Record<ProviderId, Backend> = { openai, gemini };

/** Normalize a raw preference value to a provider id. */
export function toProviderId(value: string | undefined): ProviderId {
  return value === "gemini" || value === "openai" ? value : DEFAULT_PROVIDER;
}

/** Shared guard for every flow: reject empty input and a missing key. */
function assertReady(
  input: string,
  provider: ProviderId,
  apiKey: string,
): string {
  const text = input.trim();
  if (text === "") {
    throw new ProviderError("empty", "Empty input — nothing to process.");
  }
  if (apiKey.trim() === "") {
    const { label, keyHint } = PROVIDERS[provider];
    const other = provider === "openai" ? " Or switch Provider to Gemini." : "";
    throw new ProviderError(
      "auth",
      `No ${label} API key set. ${keyHint}.${other}`,
    );
  }
  return text;
}

/** Null on a normal finish; otherwise the reason the model stopped early. */
function cutShortFrom(call: CallResult): string | null {
  return call.finish === "done" ? null : (call.reason ?? call.finish);
}

/**
 * Translate. `part` = "full" (translation + block per the rules) or
 * "translation" (translation only, on-demand mode). Streams under the hood;
 * `opts.onUpdate` receives each partial result, the promise the final one.
 */
export async function translate(
  input: string,
  opts: TranslateOptions,
  part: TranslatePart = "full",
): Promise<TranslateResult> {
  const text = assertReady(input, opts.provider, opts.apiKey);
  const onlyTranslation = part === "translation";
  let raw = "";
  const call = await BACKENDS[opts.provider].stream(
    {
      system: buildTranslateSystemPrompt(opts, part),
      user: buildTranslateUserPrompt(text, part),
      maxTokens: onlyTranslation
        ? translationOnlyCap(text)
        : translateCap(text),
      opts,
    },
    (delta) => {
      raw += delta;
      if (opts.onUpdate) {
        const progress = readTranslateOutput(raw, false, text);
        opts.onUpdate(
          onlyTranslation ? { ...progress, explanation: null } : progress,
        );
      }
    },
  );
  const result = readTranslateOutput(call.text, true, text);
  return {
    translation: result.translation,
    explanation: onlyTranslation ? null : result.explanation,
    cutShort: cutShortFrom(call),
  };
}

/**
 * Explain (on-demand mode): the block for `translation`, always produced.
 * `opts.onUpdate` receives the translation plus the explanation so far.
 */
export async function explain(
  input: string,
  translation: string,
  opts: TranslateOptions,
): Promise<ExplainResult> {
  const text = assertReady(input, opts.provider, opts.apiKey);
  let raw = "";
  const call = await BACKENDS[opts.provider].stream(
    {
      system: buildExplainSystemPrompt(opts),
      user: buildExplainUserPrompt(text, translation),
      maxTokens: translateCap(text),
      opts,
    },
    (delta) => {
      raw += delta;
      opts.onUpdate?.({
        translation,
        explanation: readExplainOutput(raw, false),
        translationDone: true,
      });
    },
  );
  const explanation = readExplainOutput(call.text, true);
  if (explanation === "") {
    throw new ProviderError(
      "parse",
      `${PROVIDERS[opts.provider].label} returned an empty explanation.`,
    );
  }
  return { explanation, cutShort: cutShortFrom(call) };
}

export async function proofread(
  input: string,
  opts: ProofreadOptions,
): Promise<ProofreadResult> {
  const text = assertReady(input, opts.provider, opts.apiKey);
  const { label } = PROVIDERS[opts.provider];
  // Streamed for the idle timeout, but nothing is used until the whole text
  // has arrived and passed the gate below.
  const call = await BACKENDS[opts.provider].stream(
    {
      system: buildProofreadSystemPrompt({
        formal: opts.formal,
        outputLanguage: opts.outputLanguage,
      }),
      user: buildProofreadUserPrompt(text),
      maxTokens: outputCap(text, opts.formal),
      opts,
    },
    () => undefined,
  );
  // A cut-short result (token cap, safety, ...) must never reach the paste.
  if (call.finish !== "done") {
    throw new ProviderError(
      "api",
      `${label} stopped early (${call.reason ?? call.finish}) — the result would be incomplete.`,
    );
  }
  return parseProofreadOutput(call.text, text, label);
}

export type {
  ExplainResult,
  ProofreadOptions,
  ProofreadResult,
  ProviderId,
  TranslateOptions,
  TranslateProgress,
  TranslateResult,
} from "./types";
