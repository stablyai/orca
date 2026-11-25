/** Bounds the HTML a composer paste parses for links; larger copies paste as plain text. */
const CLIPBOARD_LINK_HTML_MAX_LENGTH = 1024 * 1024

/** Cheap pre-parse check: only HTML with an anchor can add links to a paste. */
export function clipboardHtmlMayHaveLinks(html: string): boolean {
  return html.length <= CLIPBOARD_LINK_HTML_MAX_LENGTH && /<a\s/i.test(html)
}
