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

/** At most `limit` code units, cut at the last word break with "…" when it doesn't fit; a single
 *  word longer than the limit is cut inside it. Whitespace is folded so it reads as one line. */
export function clipAtWord(value: string, limit: number): string {
  const line = value.replace(/\s+/g, ' ').trim()
  if (line.length <= limit) {
    return line
  }
  const room = sliceAtCodeUnitLimit(line, Math.max(limit - 1, 0))
  // The room ends on a word when a space follows it; else at its last break past half the room, as an
  // earlier one would leave too little.
  const lastSpace = line[room.length] === ' ' ? room.length : room.lastIndexOf(' ')
  const cut = lastSpace > room.length / 2 ? room.slice(0, lastSpace) : room
  return `${cut.trimEnd().replace(/[\s,;:–—-]+$/u, '')}…`
}
