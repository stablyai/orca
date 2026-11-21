// Lone surrogates make encodeURIComponent throw. Not toWellFormed() (Android WebView <111) and no lookbehind (WebKit <16.4).
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu

/** encodeURIComponent that encodes lone surrogates (e.g. a clipped emoji) as U+FFFD instead of throwing. */
export function encodeWellFormedURIComponent(value: string): string {
  try {
    return encodeURIComponent(value)
  } catch {
    // Why: scan only after the throw so well-formed text, the common case, costs nothing extra.
    return encodeURIComponent(value.replace(LONE_SURROGATE, '\uFFFD'))
  }
}
