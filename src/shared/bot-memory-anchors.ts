/** The non-blank line a fact followed (null: the top of the file). */
export type BotMemoryAnchor = {
  after: string | null
  /** The anchor's 1-based occurrence. Older history rows keep only its text. */
  afterOccurrence?: number
}

/** Where the fact belongs by its anchor, falling back to the end if the anchor is gone. A row
 *  without an occurrence takes the first, so a later copy of the line (one in a code fence, say)
 *  never pulls the fact further down. */
export function botMemoryInsertionIndex(
  lines: readonly string[],
  { after, afterOccurrence = 1 }: BotMemoryAnchor
): number {
  if (after === null) {
    return 0
  }
  let anchor = -1
  for (let seen = 0; seen < afterOccurrence; seen += 1) {
    anchor = lines.indexOf(after, anchor + 1)
    if (anchor === -1) {
      break
    }
  }
  return anchor === -1 ? lines.findLastIndex((raw) => raw.trim() !== '') + 1 : anchor + 1
}
