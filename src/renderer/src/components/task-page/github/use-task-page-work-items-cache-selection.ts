import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import {
  getTaskPageRepoCacheRows,
  createTaskPageWorkItemsCacheSelector
} from '@/components/task-page/task-page-cache-selectors'
import { isGitHubWorkItemsQueryTooLarge } from '../../../../../shared/github/work-items-query-bounds'
import type { Repo } from '../../../../../shared/repo-types'
import { getTaskPageRepoCacheInput } from '../task-page-source-context'

/** Selected rows' current-query cache entries, plus the entries the source displays read (see the selector). */
export function useTaskPageWorkItemsCacheSelection(
  selectedRepos: readonly Repo[],
  githubPerRepoPageLimit: number,
  appliedWorkItemsCacheQuery: string
) {
  const collections = useAppStore((s) => s.githubSourceCollections)
  const revision = useSyncExternalStore(collections.subscribe, collections.snapshot)
  const workItemsCacheRows = useMemo(
    () =>
      getTaskPageRepoCacheRows(
        selectedRepos.map(getTaskPageRepoCacheInput),
        githubPerRepoPageLimit,
        appliedWorkItemsCacheQuery
      ),
    [appliedWorkItemsCacheQuery, githubPerRepoPageLimit, selectedRepos]
  )
  // Why a ref, not state: each row's last committed current cache key; the entry is always read live.
  const sourceDisplayCacheKeysRef = useRef(new Map<string, string>())
  const candidates = useMemo(
    () =>
      new Map(
        workItemsCacheRows.map((row, index) => [
          row.sourceKey,
          collections.candidate(selectedRepos[index])
        ])
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the external collection snapshot invalidates this derived projection.
    [collections, selectedRepos, workItemsCacheRows, revision]
  )
  const selectWorkItemsCacheEntries = useMemo(
    () =>
      createTaskPageWorkItemsCacheSelector(
        workItemsCacheRows,
        !isGitHubWorkItemsQueryTooLarge(appliedWorkItemsCacheQuery),
        (sourceKey) => sourceDisplayCacheKeysRef.current.get(sourceKey),
        (sourceKey) => candidates.get(sourceKey)
      ),
    [appliedWorkItemsCacheQuery, workItemsCacheRows, candidates]
  )
  const { current: selectedWorkItemsCacheEntries, display: sourceDisplayWorkItemsCacheEntries } =
    useAppStore((s) => selectWorkItemsCacheEntries(s.workItemsCache))
  useEffect(() => {
    // After commit: a present current entry (even unresolved) becomes the row's display entry; rows that left drop theirs.
    const displayCacheKeys = sourceDisplayCacheKeysRef.current
    const selectedSourceKeys = new Set<string>()
    for (const [index, row] of workItemsCacheRows.entries()) {
      selectedSourceKeys.add(row.sourceKey)
      if (selectedWorkItemsCacheEntries[index]) {
        displayCacheKeys.set(row.sourceKey, row.cacheKey)
      }
    }
    for (const sourceKey of displayCacheKeys.keys()) {
      if (!selectedSourceKeys.has(sourceKey)) {
        displayCacheKeys.delete(sourceKey)
      }
    }
  }, [selectedWorkItemsCacheEntries, workItemsCacheRows])
  return { selectedWorkItemsCacheEntries, sourceDisplayWorkItemsCacheEntries }
}
