// Cutting text to a length bound without splitting a character in half.
//
// JavaScript string length counts UTF-16 code units, so a raw `slice` at a
// bound can land between the two halves of an astral character — an emoji, or
// most CJK extension characters — and leave a lone surrogate that every surface
// renders as U+FFFD.

/** Cut to `limit` UTF-16 code units without splitting a trailing surrogate pair. */
export function sliceAtCodeUnitLimit(value: string, limit: number): string {
  if (value.length <= limit) {
    return value
  }
  const end = limit > 0 && isHighSurrogate(value.charCodeAt(limit - 1)) ? limit - 1 : limit
  return value.slice(0, end)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
