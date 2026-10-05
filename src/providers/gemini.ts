/** Google Gemini streamGenerateContent (SSE) for every flow — proofread too,
 *  so a long healthy reply is never cut by a total timeout. The key goes in the
 *  x-goog-api-key header (not the URL). Plain-text output, with thinking turned
 *  as low as the model family allows (thinkingFor). */

import { postStream } from "../lib/http";
import { ProviderError } from "../lib/errors";
import type { Backend, CallArgs, CallResult, Finish } from "./types";

const LABEL = "Gemini";

/**
 * Output-token headroom for thought tokens, which Gemini counts against
 * maxOutputTokens. ESTIMATE — not measured: "low"/"minimal" thinking is
 * reported in the low thousands of tokens; 8192 leaves margin.
 */
export const THINKING_HEADROOM = 8192;

function endpoint(model: string): string {
  // `model` comes from a user-editable preference; encodeURIComponent keeps it
  // inside the path segment (no host/path injection).
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/**
 * Thinking config per model family (docs: ai.google.dev/gemini-api/docs/
 * generate-content/thinking). 2.5 models take a budget (thinkingLevel is an
 * error there): 0 turns it off, except on 2.5 Pro, which cannot turn it off
 * and takes its documented minimum, 128. 3.x take a level: "minimal" where the
 * docs list it (3, 3.5, 3.6 Flash; 3.1 and 3.5 Flash-Lite), "low" elsewhere
 * ("minimal" is an error on 3.7/3.8 Flash and 3.1 Pro). Unknown ids (aliases,
 * 2.0) get no config so the request stays valid.
 */
export function thinkingFor(
  model: string,
): Record<string, unknown> | undefined {
  const id = model.trim().toLowerCase();
  if (/^gemini-2\.5-pro/.test(id)) {
    return { thinkingBudget: 128 };
  }
  if (/^gemini-2\.5-/.test(id)) {
    return { thinkingBudget: 0 };
  }
  if (
    /^gemini-3\.[15]-flash-lite/.test(id) ||
    /^gemini-3(\.[56])?-flash(?!-lite)/.test(id)
  ) {
    return { thinkingLevel: "minimal" };
  }
  if (/^gemini-([3-9]|\d{2,})(\.|-)/.test(id)) {
    return { thinkingLevel: "low" };
  }
  return undefined;
}

/** True when the config turns thinking fully off (budget 0). */
function isThinkingOff(config: Record<string, unknown> | undefined): boolean {
  return config?.thinkingBudget === 0;
}

/** `args.maxTokens` is the visible-text budget; thinking headroom goes on top. */
export function buildBody(args: CallArgs): Record<string, unknown> {
  const thinkingConfig = thinkingFor(args.opts.model);
  const headroom = isThinkingOff(thinkingConfig) ? 0 : THINKING_HEADROOM;
  return {
    systemInstruction: { parts: [{ text: args.system }] },
    contents: [{ role: "user", parts: [{ text: args.user }] }],
    generationConfig: {
      maxOutputTokens: args.maxTokens + headroom,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
  };
}

function finishFrom(reason: string): Finish {
  switch (reason) {
    case "STOP":
      return "done";
    case "MAX_TOKENS":
      return "truncated";
    case "SAFETY":
    case "RECITATION":
      return "blocked";
    default:
      return "other";
  }
}

/** Throw on a blocked prompt or an error object; return the chunk's visible text. */
function readChunk(json: GeminiResponse): string {
  if (json.error) {
    throw new ProviderError(
      "api",
      `Gemini API error: ${json.error.status ?? json.error.message ?? "unknown"}.`,
      { cause: json.error },
    );
  }
  if (json.promptFeedback?.blockReason) {
    throw new ProviderError(
      "api",
      `Gemini blocked the request: ${json.promptFeedback.blockReason}.`,
    );
  }
  return (json.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Fold one streamed chunk into the running state. Exported for the offline
 * check (scripts/check-stream.ts).
 */
export function foldGeminiChunk(
  data: string,
  onText: (delta: string) => void,
): { reason?: string } {
  let json: GeminiResponse;
  try {
    json = JSON.parse(data) as GeminiResponse;
  } catch (cause) {
    throw new ProviderError(
      "parse",
      "Gemini sent an unreadable stream chunk.",
      { cause },
    );
  }
  const text = readChunk(json);
  if (text !== "") {
    onText(text);
  }
  return { reason: json.candidates?.[0]?.finishReason };
}

function emptyGuard(text: string): void {
  if (text.trim() === "") {
    throw new ProviderError("parse", "Gemini returned an empty response.");
  }
}

async function streamGemini(
  args: CallArgs,
  onText: (delta: string) => void,
): Promise<CallResult> {
  let text = "";
  let reason: string | undefined;
  await postStream({
    url: endpoint(args.opts.model),
    headers: { "x-goog-api-key": args.opts.apiKey },
    body: buildBody(args),
    label: LABEL,
    signal: args.opts.signal,
    onEvent: (data) => {
      const chunk = foldGeminiChunk(data, (delta) => {
        text += delta;
        onText(delta);
      });
      reason = chunk.reason ?? reason;
    },
  });
  emptyGuard(text);
  // The last chunk carries finishReason; a stream that ended without one was cut.
  if (reason === undefined) {
    return { text, finish: "other", reason: "stream ended early" };
  }
  return { text, finish: finishFrom(reason), reason };
}

export const gemini: Backend = { stream: streamGemini };
