/**
 * Prompt fragments shared by more than one command.
 *
 * Only genuinely-shared pieces live here. The translate system prompt keeps its
 * own "what not to translate" wording inline (its phrasing is entangled with the
 * translation flow), so this module exports the protected-terms block for the
 * proofread prompt plus the `<input>` fencing helper both user prompts use.
 */

/**
 * Protected-terms rule block for the proofread prompt. Stated to OVERRIDE the
 * inline-fragment translation rule: these tokens are kept verbatim even when
 * they look like a stray foreign fragment.
 */
export const PROTECTED_TERMS = `## Keep verbatim — overrides the fragment rule above
Never translate, transliterate, or "fix" these, even when they look like a foreign fragment:
- Proper nouns, brand and product names.
- Technical and developer terms and identifiers: code, function/class/hook names, file paths, URLs, version numbers, and CLI commands (push, merge, rebase, main, CI, ...).`;

/**
 * Neutralize every closing-tag variant of `tag` (any case, optional whitespace:
 * `</input>`, `</ input>`, `</INPUT\t>`) so untrusted text can't close the
 * fence it sits in. The slash gets a backslash: `<\/input>`.
 */
export function escapeClosingTag(text: string, tag: string): string {
  const closing = new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi");
  return text.replace(closing, (match) => match.replace("/", "\\/"));
}

/**
 * Wrap the user's text in <input></input> so the model reads it as data, not
 * instructions. A literal closing delimiter is neutralized so the input can't
 * break out of the fence.
 */
export function wrapInput(input: string): string {
  const safe = escapeClosingTag(input, "input");
  return `<input>\n${safe}\n</input>`;
}
