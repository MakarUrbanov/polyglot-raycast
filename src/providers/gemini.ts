/** Google Gemini generateContent. The key goes in the x-goog-api-key header (not the URL).
 *  Translate asks for JSON via responseMimeType; proofread asks for plain text with
 *  thinking disabled and a generous output cap. Both go through callGemini(). */

import {
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
} from "../prompts/translate";
import {
  buildProofreadSystemPrompt,
  buildProofreadUserPrompt,
} from "../prompts/proofread";
import { postJson } from "../lib/http";
import { parseProofreadOutput, parseTranslateOutput } from "../lib/parse";
import { ProviderError } from "../lib/errors";
import type {
  BaseOptions,
  ProofreadOptions,
  ProofreadResult,
  TranslateOptions,
  TranslateResult,
} from "./types";

function endpoint(model: string): string {
  // `model` comes from a user-editable preference; encodeURIComponent keeps it
  // inside the path segment (no host/path injection).
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

interface CallArgs {
  system: string;
  user: string;
  generationConfig: Record<string, unknown>;
  opts: BaseOptions;
}

interface CallResult {
  text: string;
  /** Gemini's finishReason for the candidate ("STOP" on a normal completion). */
  finishReason?: string;
}

/** Shared request mechanics: build the body, POST, unwrap, return the raw text. */
async function callGemini(args: CallArgs): Promise<CallResult> {
  const { system, user, generationConfig, opts } = args;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig,
  };

  const json = (await postJson({
    url: endpoint(opts.model),
    headers: { "x-goog-api-key": opts.apiKey },
    body,
    label: "Gemini",
    signal: opts.signal,
  })) as GeminiResponse;

  if (json.promptFeedback?.blockReason) {
    throw new ProviderError(
      "api",
      `Gemini blocked the request: ${json.promptFeedback.blockReason}.`,
    );
  }

  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (text.trim() === "") {
    throw new ProviderError("parse", "Gemini returned an empty response.");
  }
  return { text, finishReason: candidate?.finishReason };
}

/**
 * Output-token budget for proofread. Cyrillic tokenizes to more tokens per
 * character than Latin, so estimate ~1 token per 2 chars and double it (×3 for
 * formal mode, which expands the text). A too-small cap risks a truncated
 * paste — the dangerous failure — so err generous. Clamped to [512, 8192].
 */
function outputCap(input: string, formal: boolean): number {
  return Math.min(
    8192,
    Math.max(512, Math.ceil(input.length / 2) * (formal ? 3 : 2)),
  );
}

export async function translateWithGemini(
  input: string,
  opts: TranslateOptions,
): Promise<TranslateResult> {
  const { text } = await callGemini({
    system: buildTranslateSystemPrompt(opts),
    user: buildTranslateUserPrompt(input),
    generationConfig: { responseMimeType: "application/json" },
    opts,
  });
  return parseTranslateOutput(text);
}

export async function proofreadWithGemini(
  input: string,
  opts: ProofreadOptions,
): Promise<ProofreadResult> {
  const { text, finishReason } = await callGemini({
    system: buildProofreadSystemPrompt({ formal: opts.formal }),
    user: buildProofreadUserPrompt(input),
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: outputCap(input, opts.formal),
    },
    opts,
  });
  // A cut-short result (MAX_TOKENS, SAFETY, ...) must never reach the paste.
  if (finishReason && finishReason !== "STOP") {
    throw new ProviderError(
      "api",
      `Gemini stopped early (${finishReason}) — the result would be incomplete.`,
    );
  }
  return parseProofreadOutput(text, input);
}
