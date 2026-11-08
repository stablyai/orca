export type ProjectHostQueryTarget = {
  name: string
  detail?: string
  /** Labels of the hosts the project is set up on, one per host. */
  hostLabels: readonly string[]
}

/** null: the project does not match. hostIndexes null: no host was named, so every host stays. */
export type ProjectHostQueryMatch = { hostIndexes: number[] | null }

function includes(text: string | undefined, needle: string): boolean {
  return text !== undefined && text.toLowerCase().includes(needle)
}

/**
 * Match "host project" queries: words found in the project's name or detail narrow by project,
 * the rest must all appear in one host's label and narrow to those hosts.
 */
export function matchProjectHostQuery(
  rawQuery: string,
  target: ProjectHostQueryTarget
): ProjectHostQueryMatch | null {
  const query = rawQuery.trim().toLowerCase()
  if (query === '' || includes(target.name, query) || includes(target.detail, query)) {
    return { hostIndexes: null }
  }
  const words = query.split(/\s+/)
  const hostWords = words.filter(
    (word) => !includes(target.name, word) && !includes(target.detail, word)
  )
  if (hostWords.length === 0) {
    return { hostIndexes: null }
  }
  // A query made only of host words would list every project on that host; that is wanted too.
  const hostIndexes = target.hostLabels.flatMap((label, index) =>
    hostWords.every((word) => includes(label, word)) ? [index] : []
  )
  return hostIndexes.length > 0 ? { hostIndexes } : null
}
