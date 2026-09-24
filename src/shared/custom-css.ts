/** User stylesheet loaded from `~/.orca/custom.css` on top of the built-in theme. */
export const CUSTOM_CSS_FILE_NAME = 'custom.css'

// Why: re-read and pushed to every window on each save; a real theme is a few KB.
export const CUSTOM_CSS_MAX_BYTES = 256 * 1024

export type CustomCssFileError =
  | { kind: 'too-large'; sizeBytes: number }
  | { kind: 'unreadable'; message: string }

export type CustomCssSnapshot = {
  path: string
  exists: boolean
  css: string
  /** Set when the file exists but could not be used. */
  error: CustomCssFileError | null
}

// Why: CSS whitespace is these five characters; JS `\s` also matches U+00A0, which CSS keeps inside a URL.
// A backslash before a newline is a line continuation: the parser removes both.
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\r?\n|([^\n]))/g

function decodeCssEscapes(value: string): string {
  return value.replace(CSS_ESCAPE, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex) {
      const codePoint = Number.parseInt(hex, 16)
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '�'
    }
    return char ?? ''
  })
}

// Matches an absolute or protocol-relative URL anywhere in a value.
const REMOTE_REFERENCE = /(?:\b(?:https?|wss?|ftp|file):|(?:^|[\s"'(,])\/\/)/i
// Why: an inline SVG needs `xmlns='http://…'`, which is text, not a fetch; drop data: URLs before matching.
const DATA_URL =
  /url\([ \t\n\r\f]*(["']?)[ \t\n\r\f]*data:[\s\S]*?\1[ \t\n\r\f]*\)|(["'])[ \t\n\r\f]*data:[\s\S]*?\2/gi
// A url()/src() left once the data: URLs are gone points at something to fetch.
const RESOURCE_FUNCTION = /(?:^|[^\w-])(?:url|src)\(/i
// image-set() also takes a bare string, so one left inside it is a reference too.
const IMAGE_SET_STRING = /image-set\([^)]*["']/i

// Why: allowlist — the URL parser normalizes too many spellings for a denylist to hold.
/** True when a value makes Chromium fetch a resource; only an inline `data:` URL passes. */
export function fetchesCustomCssResource(value: string): boolean {
  const withoutDataUrls = decodeCssEscapes(value).replace(DATA_URL, '')
  if (RESOURCE_FUNCTION.test(withoutDataUrls) || IMAGE_SET_STRING.test(withoutDataUrls)) {
    return true
  }
  // Why: the URL parser drops ASCII tab/newline and folds `\` to `/`, so a scheme can hide outside url().
  return REMOTE_REFERENCE.test(withoutDataUrls.replace(/[\t\n\r]/g, '').replace(/\\/g, '/'))
}
