/** Release complete phrases, with a short word group for prose without punctuation. */
export function nativeChatPhraseEnd(
  text: string,
  previousEnd: number,
  proposedEnd: number,
  flush: boolean
): number {
  const limit = Math.min(text.length, Math.max(0, proposedEnd))
  if (flush) {
    return limit
  }
  let end = Math.min(previousEnd, limit)
  let words = 0
  for (let index = end; index < limit; index++) {
    const char = text[index]
    const whitespace = /\s/u.test(char)
    if (whitespace && index > end && !/\s/u.test(text[index - 1])) {
      words++
    }
    const punctuation =
      /[。！？；，、\n]/u.test(char) ||
      (/[.!?;:,]/u.test(char) && (index + 1 === text.length || /\s/u.test(text[index + 1])))
    if (punctuation || (whitespace && (words >= 4 || index - end >= 48))) {
      end = index + 1
      words = 0
    }
  }
  return end
}
