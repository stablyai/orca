// UTF-16 slice bounds can split astral characters and leave lone surrogates rendered as U+FFFD.

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
