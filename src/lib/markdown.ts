/**
 * Defang markdown images in model-derived text before rendering. Detail loads
 * `![](url)` images automatically, which would beacon out to a URL the model
 * (i.e. arbitrary input) can choose.
 *
 * The `[` is escaped, not the `!`: escaping the `!` (`\![`) is undone by a
 * backslash already in front of it (`\![` → `\\![` = a literal backslash, then
 * a live image). `!\[` cannot be undone that way — the backslash sits between
 * `!` and `[`, so it always escapes the `[`, and with no `[` there is no link
 * or image to open. The text stays readable, as `![…](…)` shown literally.
 */
export function defangImages(markdown: string): string {
  return markdown.replace(/!\[/g, "!\\[");
}
