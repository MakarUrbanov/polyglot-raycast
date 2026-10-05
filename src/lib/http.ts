/**
 * Shared HTTP for the providers: a streaming POST that reads server-sent
 * events, with an idle timeout instead of a total one, plus status mapping.
 * `label` is the service name used in error messages (e.g. "Gemini").
 */

import { ProviderError, errorFromStatus } from "./errors";
import { SseParser } from "./sse";

export interface PostStreamArgs {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Service name used in error messages. */
  label: string;
  /** External cancellation (e.g. component unmount). */
  signal?: AbortSignal;
  /** Called with the `data` payload of every server-sent event. */
  onEvent: (data: string) => void;
  /** Abort when no bytes arrive for this long between chunks. */
  idleMs?: number;
  /** Abort when the first body byte takes longer than this (thinking time). */
  firstByteMs?: number;
}

const IDLE_MS = 30_000;

/**
 * Wait for the first byte: a thinking model can be silent for a while before
 * its first chunk. ESTIMATE — not measured; 60 s is double the idle window.
 */
const FIRST_BYTE_MS = 60_000;

/**
 * A controller that aborts on the external signal or on our own timer.
 * Composed WITHOUT AbortSignal.any, which has a Node bug (#57736) that can
 * stop fetch timeouts from firing.
 */
function linkAbort(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }
  return controller;
}

/** Map a fetch/read failure to the right error kind. */
function failureFrom(
  cause: unknown,
  label: string,
  signal: AbortSignal | undefined,
  timer: AbortController,
  timeoutText: () => string,
  midStream = false,
): unknown {
  // `.aborted` is set synchronously by abort(), so these checks are race-free.
  if (signal?.aborted) {
    return cause; // external cancellation — the caller ignores it
  }
  if (cause instanceof ProviderError) {
    return cause;
  }
  if (timer.signal.aborted) {
    return new ProviderError("timeout", timeoutText(), { cause });
  }
  const text = midStream
    ? `The connection to ${label} was lost mid-response.`
    : `Could not reach ${label}. Check your connection.`;
  return new ProviderError("network", text, { cause });
}

/**
 * POST and read the response as server-sent events. There is no total time
 * cap: a healthy long stream keeps going. Only silence aborts it as a timeout —
 * `firstByteMs` until the first body byte (re-armed when the headers arrive),
 * then `idleMs` between chunks.
 */
export async function postStream(args: PostStreamArgs): Promise<void> {
  const {
    url,
    headers,
    body,
    label,
    signal,
    onEvent,
    idleMs = IDLE_MS,
    firstByteMs = FIRST_BYTE_MS,
  } = args;

  const idleController = linkAbort(signal);
  let windowMs = firstByteMs;
  let timer = setTimeout(() => idleController.abort(), windowMs);
  const arm = (ms: number) => {
    windowMs = ms;
    clearTimeout(timer);
    timer = setTimeout(() => idleController.abort(), ms);
  };
  const timeoutText = () =>
    `${label} sent no data for ${Math.round(windowMs / 1000)} s.`;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: idleController.signal,
      });
    } catch (cause) {
      throw failureFrom(cause, label, signal, idleController, timeoutText);
    }
    arm(firstByteMs);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw errorFromStatus(label, response.status, text);
    }
    if (!response.body) {
      throw new ProviderError("parse", `${label} returned an empty stream.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const parser = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        arm(idleMs);
        const text = decoder.decode(value, { stream: true });
        parser.push(text).forEach(onEvent);
      }
      parser.push(decoder.decode()).forEach(onEvent);
      parser.flush().forEach(onEvent);
    } catch (cause) {
      // Release the connection; a cancel failure changes nothing for the caller.
      void reader.cancel().catch(() => undefined);
      throw failureFrom(
        cause,
        label,
        signal,
        idleController,
        timeoutText,
        true,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
