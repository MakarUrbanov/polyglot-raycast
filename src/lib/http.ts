/**
 * Shared POST-JSON with a timeout and error mapping. `label` is the service name
 * used in error messages (e.g. "Gemini").
 */

import { ProviderError, errorFromStatus } from "./errors";

export interface PostJsonArgs {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Service name used in error messages. */
  label: string;
  /** External cancellation (e.g. component unmount). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Returns the parsed JSON envelope (the caller parses the envelope shape). */
export async function postJson(args: PostJsonArgs): Promise<unknown> {
  const {
    url,
    headers,
    body,
    label,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = args;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Compose the external signal with our timeout WITHOUT AbortSignal.any, which
  // has a Node bug (#57736) that can stop fetch timeouts from firing.
  if (signal) {
    if (signal.aborted) {
      timeoutController.abort();
    } else {
      signal.addEventListener("abort", () => timeoutController.abort(), {
        once: true,
      });
    }
  }

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: timeoutController.signal,
      });
    } catch (cause) {
      // `.aborted` is set synchronously by abort(), so these checks are race-free.
      if (signal?.aborted) {
        throw cause; // external cancellation — the caller ignores it
      }
      if (timeoutController.signal.aborted) {
        throw new ProviderError(
          "timeout",
          `Request to ${label} timed out (${timeoutMs} ms).`,
          { cause },
        );
      }
      throw new ProviderError(
        "network",
        `Could not reach ${label}. Check your connection.`,
        { cause },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw errorFromStatus(label, response.status, text);
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new ProviderError(
        "parse",
        `${label} returned a non-JSON response body.`,
        { cause },
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
