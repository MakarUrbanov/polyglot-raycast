/**
 * Output-token caps. They are runaway guards, not length shaping — the prompt
 * limits shape the explanation. Cyrillic tokenizes to more tokens per
 * character than Latin, so the per-input allowance assumes ~1 token per
 * 2 chars and doubles it. These caps budget VISIBLE text only: OpenAI runs
 * with reasoning effort "none", and the Gemini backend adds THINKING_HEADROOM
 * on top whenever the model may think (thought tokens count against its cap).
 */

/** Allowance for re-emitting the input: ~1 token per 2 chars, doubled. */
function inputAllowance(input: string): number {
  return Math.ceil(input.length / 2) * 2;
}

/**
 * Proofread: ×3 for formal mode, which expands the text. A too-small cap risks
 * a truncated paste — the dangerous failure — so err generous. Clamped to
 * [512, 8192].
 */
export function outputCap(input: string, formal: boolean): number {
  return Math.min(
    8192,
    Math.max(512, Math.ceil(input.length / 2) * (formal ? 3 : 2)),
  );
}

/**
 * Translate with the explanation block (and the explanation-only request).
 * A capped dictionary entry is ~600–1000 tokens (ESTIMATE — not measured); the
 * 8192 base is ~8× that.
 */
export function translateCap(input: string): number {
  return Math.min(32768, 8192 + inputAllowance(input));
}

/** Translation-only request (on-demand mode): no block to budget for. */
export function translationOnlyCap(input: string): number {
  return Math.min(16384, 1024 + inputAllowance(input));
}
