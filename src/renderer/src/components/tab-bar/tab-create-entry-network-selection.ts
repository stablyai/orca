import { useEffect, useRef } from 'react'
import { getActiveOptionId, type ActiveOption } from './tab-create-entry-active-option'
import { isUnambiguousSearchQuery } from './tab-create-entry-file-matches'
import { classifyExplicitUrl } from './tab-create-entry-url-classification'

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
  const missingPinnedAgent =
    pinnedOptionIndex < 0 &&
    (pinnedOptionId?.startsWith('chat:') || pinnedOptionId?.startsWith('cli:'))
  const rankedOption = pinnedOptionIndex < 0 ? activeOptions[0] : undefined
  const rankedClassification =
    rankedOption?.kind === 'entry' ? rankedOption.option.classification : null
  // Explicit URLs cannot match workspace files, even when represented by a history row.
  const rankedNetworkAction =
    !forcedSearch &&
    ((rankedOption?.kind === 'history' &&
      classifyExplicitUrl(query.trim())?.kind !== 'explicit-url') ||
      rankedClassification?.kind === 'search' ||
      rankedClassification?.kind === 'host-url')
  // Hold network Enter until scanning cannot change ranking: completed/failed indexing or an unambiguous search phrase.
  const networkRankingSettled =
    fileIndexReady ||
    fileIndexFailed ||
    (rankedClassification?.kind === 'search' &&
      isUnambiguousSearchQuery(rankedClassification.query))
  const rankingKey = `${menuOpen}:${query}`
  const hasRankedOption = rankedOption !== undefined
  // Do not arm network Enter after reindexing replaces a file ranking; require fresh typing to establish intent.
  const blockedNetworkRankingRef = useRef<string | null>(null)
  useEffect(() => {
    if (fileIndexReady && hasRankedOption && !rankedNetworkAction) {
      blockedNetworkRankingRef.current = rankingKey
    }
  }, [fileIndexReady, hasRankedOption, rankedNetworkAction, rankingKey])
  const networkActionAllowed =
    networkRankingSettled && blockedNetworkRankingRef.current !== rankingKey
  const activeSelectedIndex = missingPinnedAgent
    ? null
    : pinnedOptionIndex >= 0
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
