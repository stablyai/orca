// Why: a generated ~/.ssh/config can import >10k hosts; a row each made one list cost GBs of DOM.
export const HOST_LIST_ROW_LIMIT = 50

export type BoundedHostList<T> = {
  shown: T[]
  /** Hosts matching the query that the limits left out. */
  hiddenCount: number
}

/** 0 exact name, 1 name prefix, 2 substring of the name or `searchText`; null for no match. */
function matchRank(host: { label: string; searchText?: string }, needle: string): number | null {
  const label = host.label.toLowerCase()
  if (label === needle) {
    return 0
  }
  if (label.startsWith(needle)) {
    return 1
  }
  if (label.includes(needle) || host.searchText?.toLowerCase().includes(needle)) {
    return 2
  }
  return null
}

/** Rank exact/prefix/substring matches with stable ties; cap pinned and other hosts separately so neither crowds out the other. */
export function boundHostList<T extends { id: string; label: string; searchText?: string }>(
  hosts: readonly T[],
  options: { query?: string; pinnedIds?: ReadonlySet<string>; limit?: number } = {}
): BoundedHostList<T> {
  const { pinnedIds, limit = HOST_LIST_ROW_LIMIT } = options
  const needle = (options.query ?? '').trim().toLowerCase()
  const ranked: { host: T; rank: number; index: number }[] = []
  hosts.forEach((host, index) => {
    const rank = matchRank(host, needle)
    if (rank !== null) {
      ranked.push({ host, rank, index })
    }
  })
  ranked.sort((a, b) => a.rank - b.rank)
  const pinned = ranked.filter((entry) => pinnedIds?.has(entry.host.id) === true)
  const others = ranked.filter((entry) => pinnedIds?.has(entry.host.id) !== true)
  const kept = [...pinned.slice(0, limit), ...others.slice(0, limit)]
  kept.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return {
    shown: kept.map((entry) => entry.host),
    hiddenCount: Math.max(0, pinned.length - limit) + Math.max(0, others.length - limit)
  }
}
