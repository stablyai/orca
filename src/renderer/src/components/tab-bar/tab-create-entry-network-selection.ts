import { useEffect, useRef } from 'react'
import { getActiveOptionId, type ActiveOption } from './tab-create-entry-active-option'
import { isUnambiguousSearchQuery } from './tab-create-entry-file-matches'

type NetworkSelectionArgs = {
  activeOptions: ActiveOption[]
  fileIndexFailed: boolean
  fileIndexReady: boolean
  forcedSearch: boolean
  menuOpen: boolean
  pinnedOptionId: string | null
  query: string
}

export function useNetworkSafeTabEntrySelection({
  activeOptions,
  fileIndexFailed,
  fileIndexReady,
  forcedSearch,
  menuOpen,
  pinnedOptionId,
  query
}: NetworkSelectionArgs): {
  activeSelectedIndex: number | null
  selectedActiveOption: ActiveOption | undefined
} {
  const pinnedOptionIndex = pinnedOptionId
    ? activeOptions.findIndex((option) => getActiveOptionId(option) === pinnedOptionId)
    : -1
  const rankedOption = pinnedOptionIndex < 0 ? activeOptions[0] : undefined
  const rankedClassification =
    rankedOption?.kind === 'entry' ? rankedOption.option.classification : null
  // A history row navigates away too, so it waits on the same scan: while the
  // index is still loading "readme" has no file rows yet, and Enter must not
  // quietly leave for readme.io.
  const rankedNetworkAction =
    !forcedSearch &&
    (rankedOption?.kind === 'history' ||
      rankedClassification?.kind === 'search' ||
      rankedClassification?.kind === 'host-url')
  // Why: a still-scanning index can promote a file match later, so hold Enter
  // unless the scan can no longer change the ranking — it failed outright, or
  // the text is a phrase that would never rank as a file.
  const networkRankingSettled =
    fileIndexReady ||
    fileIndexFailed ||
    (rankedClassification?.kind === 'search' &&
      isUnambiguousSearchQuery(rankedClassification.query))
  const rankingKey = `${menuOpen}:${query}`
  const hasRankedOption = rankedOption !== undefined
  // Why: once a query ranked a local action first, a later re-index that promotes
  // a network row must not arm Enter under the user's fingers — the text they
  // aimed at a file would silently leave for a search engine. Retyping clears it.
  const blockedNetworkRankingRef = useRef<string | null>(null)
  useEffect(() => {
    if (fileIndexReady && hasRankedOption && !rankedNetworkAction) {
      blockedNetworkRankingRef.current = rankingKey
    }
  }, [fileIndexReady, hasRankedOption, rankedNetworkAction, rankingKey])
  const networkActionAllowed =
    networkRankingSettled && blockedNetworkRankingRef.current !== rankingKey
  const activeSelectedIndex =
    pinnedOptionIndex >= 0
      ? pinnedOptionIndex
      : activeOptions.length === 0 || (rankedNetworkAction && !networkActionAllowed)
        ? null
        : 0
  return {
    activeSelectedIndex,
    selectedActiveOption:
      activeSelectedIndex === null ? undefined : activeOptions[activeSelectedIndex]
  }
}
