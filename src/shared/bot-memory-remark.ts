// A MEMORY.md line given Orca's mark with every other byte kept: a fact's spacing can be its value.

/**
 * `raw` with the source it claims after `separator`, if any, swapped for `mark` (null: none), every
 * other byte as it was; a line with neither stays byte for byte. Linear, with no regex to backtrack.
 */
export function remarkedBotMemoryLine(
  raw: string,
  source: string | null,
  mark: string | null,
  separator: string
): string {
  if (source === null && mark === null) {
    return raw
  }
  let bare = raw.trimEnd()
  if (source !== null) {
    // The line ends with the separator, any spaces, then `source`: that separator is the mark.
    const from = bare.length - source.length - separator.length
    bare = bare.slice(0, bare.lastIndexOf(separator, from)).trimEnd()
  }
  return mark ? `${bare}${separator}${mark}` : bare
}
