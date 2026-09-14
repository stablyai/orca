/**
 * Reading the field shape of a published frame from the frame itself, so a
 * cross-version expectation can be stated against the build that produced it.
 *
 * The baseline this suite pairs against is whichever release tag is newest, and
 * that moves on every cut. An expectation written as a literal list of fields the
 * old side does or does not have therefore expires by itself: the first release
 * containing an already-merged optional field turns the assertion red on whatever
 * pull request happens to be in flight, with no code change anywhere.
 */

export type PublishedFieldSkew = {
  /** Names only the newer side publishes — additive, and safe under Rule 1. */
  added: string[]
  /** Names the older side still publishes and the newer side dropped — a break. */
  removed: string[]
}

/** Sorted keys from one published frame occurrence. */
export function publishedFieldNames(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).sort()
}

/**
 * Which field names the two sides disagree on, by direction. Both sides are read
 * from a real pairing; neither is a list this file knows.
 */
export function comparePublishedFields(args: {
  older: string[]
  newer: string[]
}): PublishedFieldSkew {
  const older = new Set(args.older)
  const newer = new Set(args.newer)
  return {
    added: [...newer].filter((name) => !older.has(name)).sort(),
    removed: [...older].filter((name) => !newer.has(name)).sort()
  }
}

/** Compare corresponding occurrences without letting sibling frames hide a removal. */
export function comparePublishedFieldOccurrences(args: {
  older: readonly Record<string, unknown>[]
  newer: readonly Record<string, unknown>[]
}): PublishedFieldSkew[] {
  if (args.older.length !== args.newer.length) {
    throw new Error(
      `Published frame occurrence count differs: older ${args.older.length}, newer ${args.newer.length}`
    )
  }

  return args.older.map((older, index) => {
    const newer = args.newer[index]
    if (!newer) {
      throw new Error(`Missing newer published frame occurrence ${index + 1}`)
    }
    return comparePublishedFields({
      older: publishedFieldNames(older),
      newer: publishedFieldNames(newer)
    })
  })
}
