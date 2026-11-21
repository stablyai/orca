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
 * How well a matched row fits the query, higher first: each word scores where it lands, so the
 * project "linux" outranks a project that only matched through the host "Local Linux".
 */
export function scoreProjectHostQuery(
  rawQuery: string,
  target: Pick<ProjectHostQueryTarget, 'name' | 'detail'>,
  hostLabel?: string
): number {
  const query = rawQuery.trim().toLowerCase()
  const name = target.name.toLowerCase()
  const wordScore = (word: string): number =>
    name === word
      ? 100
      : name.startsWith(word)
        ? 80
        : name.includes(word)
          ? 60
          : includes(target.detail, word)
            ? 30
            : includes(hostLabel, word)
              ? 10
              : 0
  const words = query.split(/\s+/).filter(Boolean)
  return words.reduce((sum, word) => sum + wordScore(word), name === query ? 50 : 0)
}

// "build orca" for detail "build/orca": "build" also names a host, and "orca" alone still finds the project.
function projectWordsNamingHosts(
  words: readonly string[],
  target: ProjectHostQueryTarget
): number[] | null {
  const named = words.filter((word) => target.hostLabels.some((label) => includes(label, word)))
  const rest = words.filter((word) => !named.includes(word))
  if (named.length === 0 || rest.length === 0) {
    return null
  }
  const hostIndexes = target.hostLabels.flatMap((label, index) =>
    named.every((word) => includes(label, word)) ? [index] : []
  )
  // Words split across hosts, or naming every host, say nothing about which one.
  return hostIndexes.length > 0 && hostIndexes.length < target.hostLabels.length
    ? hostIndexes
    : null
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
    return { hostIndexes: projectWordsNamingHosts(words, target) }
  }
  // A query made only of host words would list every project on that host; that is wanted too.
  const hostIndexes = target.hostLabels.flatMap((label, index) =>
    hostWords.every((word) => includes(label, word)) ? [index] : []
  )
  return hostIndexes.length > 0 ? { hostIndexes } : null
}
