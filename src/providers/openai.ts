/** OpenAI Responses API (POST /v1/responses). The key goes in the
 *  Authorization header. Plain-text output, hidden reasoning off
 *  (reasoning.effort "none"), and store: false so the user's text is not kept
 *  server-side. Every flow streams — proofread too, so a long healthy reply is
 *  never cut by a total timeout. The terminal event (completed / incomplete /
 *  failed) decides whether the result is whole. */

import { postStream } from "../lib/http";
import { ProviderError } from "../lib/errors";
import type { Backend, CallArgs, CallResult, Finish } from "./types";

const LABEL = "OpenAI";
const ENDPOINT = "https://api.openai.com/v1/responses";

interface ResponseBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string | null; message?: string } | null;
}

interface StreamEvent {
  type?: string;
  delta?: string;
  code?: string | null;
  response?: ResponseBody;
}

/** The state a stream event leaves behind (set only by terminal events). */
export interface FoldState {
  finish?: Finish;
  reason?: string;
}

function buildBody(args: CallArgs): Record<string, unknown> {
  return {
    model: args.opts.model,
    instructions: args.system,
    input: args.user,
    reasoning: { effort: "none" },
    max_output_tokens: args.maxTokens,
    store: false,
    stream: true,
  };
}

/** Map an incomplete response's reason to the normalized finish. */
function incompleteFinish(reason: string | undefined): Finish {
  if (reason === "max_output_tokens") {
    return "truncated";
  }
  return reason === "content_filter" ? "blocked" : "other";
}

function failedError(body: ResponseBody | undefined): ProviderError {
  const code = body?.error?.code ?? "unknown";
  return new ProviderError(
    "api",
    `OpenAI could not generate a response (${code}).`,
    { cause: body?.error },
  );
}

function refusalError(): ProviderError {
  return new ProviderError("api", "OpenAI refused the request.");
}

/**
 * Fold one streamed event: text deltas go to `onText`, terminal events return
 * the finish. Exported for the offline check (scripts/check-stream.ts).
 */
export function foldOpenAIEvent(
  data: string,
  onText: (delta: string) => void,
): FoldState {
  let event: StreamEvent;
  try {
    event = JSON.parse(data) as StreamEvent;
  } catch (cause) {
    throw new ProviderError(
      "parse",
      "OpenAI sent an unreadable stream event.",
      { cause },
    );
  }
  switch (event.type) {
    case "response.output_text.delta":
      if (event.delta) {
        onText(event.delta);
      }
      return {};
    case "response.refusal.delta":
    case "response.refusal.done":
      throw refusalError();
    case "response.completed":
      return { finish: "done", reason: "completed" };
    case "response.incomplete": {
      const reason = event.response?.incomplete_details?.reason ?? "incomplete";
      return { finish: incompleteFinish(reason), reason };
    }
    case "response.failed":
      throw failedError(event.response);
    case "error":
      throw new ProviderError(
        "api",
        `OpenAI stream error (${event.code ?? "unknown"}).`,
        { cause: event },
      );
    default:
      return {};
  }
}

/**
 * A 400 naming reasoning.effort means the chosen model rejects "none" (e.g.
 * GPT-6 Astra). Turn it into an actionable message instead of a bare HTTP 400.
 */
function rejectsEffort(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.status !== 400) {
    return false;
  }
  try {
    const body = JSON.parse(String(error.cause)) as {
      error?: { param?: string };
    };
    return body.error?.param === "reasoning.effort";
  } catch {
    return false;
  }
}

function withEffortHint(error: unknown, model: string): unknown {
  if (!rejectsEffort(error)) {
    return error;
  }
  return new ProviderError(
    "api",
    `Model "${model}" does not accept reasoning effort "none". Set OpenAI Model to gpt-6-luna or another model that supports it.`,
    { status: 400, cause: error },
  );
}

function emptyGuard(text: string): void {
  if (text.trim() === "") {
    throw new ProviderError("parse", "OpenAI returned an empty response.");
  }
}

async function streamOpenAI(
  args: CallArgs,
  onText: (delta: string) => void,
): Promise<CallResult> {
  let text = "";
  let state: FoldState = {};
  try {
    await postStream({
      url: ENDPOINT,
      headers: { authorization: `Bearer ${args.opts.apiKey}` },
      body: buildBody(args),
      label: LABEL,
      signal: args.opts.signal,
      onEvent: (data) => {
        const next = foldOpenAIEvent(data, (delta) => {
          text += delta;
          onText(delta);
        });
        state = next.finish ? next : state;
      },
    });
  } catch (error) {
    throw withEffortHint(error, args.opts.model);
  }
  emptyGuard(text);
  if (!state.finish) {
    return { text, finish: "other", reason: "stream ended early" };
  }
  return { text, finish: state.finish, reason: state.reason };
}

export const openai: Backend = { stream: streamOpenAI };
