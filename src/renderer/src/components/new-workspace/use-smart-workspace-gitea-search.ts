import { useEffect } from 'react'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { resolveGiteaWorkItemsForQuery } from '@/lib/gitea-work-item-source-lookup'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
import type { useWorkItemSourceFoundation } from './use-work-item-source-foundation'

type Foundation = ReturnType<typeof useWorkItemSourceFoundation>

export function useSmartWorkspaceGiteaSearch({
  foundation,
  shouldQueryGitea
}: {
  foundation: Foundation
  shouldQueryGitea: boolean
}): void {
  const {
    debouncedQuery,
    disabled,
    repoBackedSearchTargets,
    mrStateFilter,
    setGiteaItems,
    setGiteaLoading
  } = foundation

  useEffect(() => {
    if (!shouldQueryGitea || disabled || repoBackedSearchTargets.length === 0) {
      setGiteaItems([])
      setGiteaLoading(false)
      return
    }
    let stale = false
    setGiteaLoading(true)
    const trimmedQuery = debouncedQuery.trim() || undefined
    // Why: an empty-query list must not briefly paint the previous non-empty result set.
    if (trimmedQuery === undefined) {
      setGiteaItems([])
    }
    void Promise.all(
      repoBackedSearchTargets.map((target) =>
        resolveGiteaWorkItemsForQuery({
          repoPath: target.repo.path,
          repoId: target.repo.id,
          repoOwnerExecutionHostId: getRepoExecutionHostId(target.repo),
          state: mrStateFilter,
          page: 1,
          perPage: RESULT_LIMIT,
          query: trimmedQuery
        }).catch(() => [])
      )
    )
      .then((results) => {
        if (stale) {
          return
        }
        setGiteaItems(
          results
            .flat()
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, RESULT_LIMIT)
        )
      })
      .catch(() => {
        if (!stale) {
          setGiteaItems([])
        }
      })
      .finally(() => {
        if (!stale) {
          setGiteaLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [
    debouncedQuery,
    disabled,
    mrStateFilter,
    repoBackedSearchTargets,
    setGiteaItems,
    setGiteaLoading,
    shouldQueryGitea
  ])
}
