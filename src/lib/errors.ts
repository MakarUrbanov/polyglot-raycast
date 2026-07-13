/**
 * A single provider error type discriminated by `kind`.
 *
 * One class with a union `kind` field instead of a class hierarchy
 * (AuthError/RateLimitError/…): callers map it with an exhaustive
 * `switch (error.kind)` rather than an instanceof chain, with less boilerplate.
 */

export type ProviderErrorKind =
  | "empty" // empty input — nothing to process
  | "auth" // key missing or rejected (401/403)
  | "rateLimit" // 429
  | "timeout" // the AbortController timeout fired
  | "network" // the connection failed
  | "parse" // the service returned an empty/unparseable envelope
  | "api"; // any other non-2xx response

export interface ProviderErrorMeta {
  status?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    meta: ProviderErrorMeta = {},
  ) {
    super(
      message,
      meta.cause !== undefined ? { cause: meta.cause } : undefined,
    );
    this.name = "ProviderError";
    this.kind = kind;
    this.status = meta.status;
  }
}

/** Normalize any caught value to a ProviderError (for uniform UI handling). */
export function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError("api", message, { cause: error });
}

/**
 * Map an HTTP status to a typed error. `label` is the service name shown to the
 * user. The raw response body is kept only in `cause` (for debugging) and is
 * never spliced into the user-facing message.
 */
export function errorFromStatus(
  label: string,
  status: number,
  body: string,
): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      "auth",
      `${label} rejected the API key (HTTP ${status}).`,
      { status, cause: body },
    );
  }
  if (status === 429) {
    return new ProviderError(
      "rateLimit",
      `${label} rate limit exceeded (HTTP 429).`,
      { status, cause: body },
    );
  }
  return new ProviderError("api", `${label} API error: HTTP ${status}.`, {
    status,
    cause: body,
  });
}
