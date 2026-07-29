import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatusEntry } from '../../../../shared/types'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitSubmoduleStatus, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import {
  getSubmoduleExpansionKey,
  isExpandableSubmoduleEntry,
  parseSubmoduleExpansionKey,
  type SubmoduleStatusState
} from './source-control-submodule-expansion'

export type UseSourceControlSubmoduleStatusInput = {
  activeWorktreeId: string | null | undefined
  worktreePath: string | null
  activeRepoSettings: RuntimeGitContext['settings']
  // Why: re-fetch expanded children whenever the parent status poll refreshes
  // its entries, so an expanded submodule's inner changes stay fresh.
  entries: readonly GitStatusEntry[]
}

export type UseSourceControlSubmoduleStatusResult = {
  expandedSubmoduleKeys: Set<string>
  submoduleStatusByKey: Record<string, SubmoduleStatusState>
  toggleSubmodule: (entry: Pick<GitStatusEntry, 'area' | 'path'>) => void
}

/**
 * Owns the lazy submodule-expansion state for Source Control: which dirty
 * submodules are expanded and the on-demand inner status for each. Dirty
 * submodules start collapsed and only query their inner `git status` when
 * expanded, so the parent status poll never recurses into (possibly nested)
 * submodules.
 */
export function useSourceControlSubmoduleStatus(
  input: UseSourceControlSubmoduleStatusInput
): UseSourceControlSubmoduleStatusResult {
  const { activeWorktreeId, worktreePath, activeRepoSettings, entries } = input
  const [expandedSubmoduleKeys, setExpandedSubmoduleKeys] = useState<Set<string>>(() => new Set())
  const [submoduleStatusByKey, setSubmoduleStatusByKey] = useState<
    Record<string, SubmoduleStatusState>
  >({})
  const activeRuntimeRouteKey = activeRepoSettings?.activeRuntimeEnvironmentId?.trim() ?? ''
  const activeConnectionRouteKey = getConnectionId(activeWorktreeId ?? null) ?? ''

  // Why: a monotonically increasing generation invalidates in-flight requests
  // when the active worktree/path/runtime/SSH route changes, so a slow response
  // from a previous target can't write stale submodule status into this panel.
  const generationRef = useRef(0)

  useEffect(() => {
    generationRef.current += 1
    setExpandedSubmoduleKeys(new Set())
    setSubmoduleStatusByKey({})
  }, [activeConnectionRouteKey, activeRuntimeRouteKey, activeWorktreeId, worktreePath])

  const fetchSubmoduleStatus = useCallback(
    async (expansionKey: string): Promise<void> => {
      if (!worktreePath) {
        return
      }
      const parsed = parseSubmoduleExpansionKey(expansionKey)
      if (!parsed) {
        return
      }
      const { area, path: submodulePath } = parsed
      const generation = generationRef.current
      // Why: keep any already-loaded children visible during a poll-driven
      // refetch so expanding then refreshing doesn't flash a loading row.
      setSubmoduleStatusByKey((prev) =>
        prev[expansionKey] ? prev : { ...prev, [expansionKey]: { status: 'loading' } }
      )
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        const result = await getRuntimeGitSubmoduleStatus(
          {
            // Why: route by the repo OWNER host, matching the rest of this panel.
            settings: activeRepoSettings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          submodulePath,
          area
        )
        if (generationRef.current !== generation) {
          return
        }
        setSubmoduleStatusByKey((prev) => ({
          ...prev,
          [expansionKey]: {
            status: 'loaded',
            entries: result.entries,
            ...(result.didHitLimit ? { didHitLimit: true } : {})
          }
        }))
      } catch (error) {
        if (generationRef.current !== generation) {
          return
        }
        setSubmoduleStatusByKey((prev) => ({
          ...prev,
          [expansionKey]: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          }
        }))
      }
    },
    [activeRepoSettings, activeWorktreeId, worktreePath]
  )

  const toggleSubmodule = useCallback((entry: Pick<GitStatusEntry, 'area' | 'path'>) => {
    const expansionKey = getSubmoduleExpansionKey(entry)
    setExpandedSubmoduleKeys((prev) => {
      const next = new Set(prev)
      if (next.has(expansionKey)) {
        next.delete(expansionKey)
      } else {
        next.add(expansionKey)
      }
      return next
    })
  }, [])

  // Why: (re)load inner status only for currently-expanded submodules. Re-runs
  // when the parent status poll refreshes `entries` so expanded children stay
  // fresh, while collapsed submodules never trigger any extra git work.
  useEffect(() => {
    const visibleExpandableKeys = new Set(
      entries.filter(isExpandableSubmoduleEntry).map(getSubmoduleExpansionKey)
    )
    for (const expansionKey of expandedSubmoduleKeys) {
      if (visibleExpandableKeys.has(expansionKey)) {
        void fetchSubmoduleStatus(expansionKey)
      }
    }
  }, [expandedSubmoduleKeys, entries, fetchSubmoduleStatus])

  return { expandedSubmoduleKeys, submoduleStatusByKey, toggleSubmodule }
}
