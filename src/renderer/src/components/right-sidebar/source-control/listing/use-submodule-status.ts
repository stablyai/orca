import { useCallback, useEffect, useState } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { isWslDistroNotRunningRefusal } from '../../../../../../shared/wsl-distro-not-running-refusal'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitSubmoduleStatus } from '@/runtime/runtime-git-status-client'
import {
  getSubmoduleExpansionKey,
  isExpandableSubmoduleEntry,
  parseSubmoduleExpansionKey,
  type SubmoduleStatusState
} from './submodule-expansion'

export type UseSourceControlSubmoduleStatusInput = {
  activeWorktreeId: string | null | undefined
  worktreePath: string | null
  activeRepoTarget: RuntimeClientTarget | null
  // Parent status refreshes invalidate expanded children so inner changes stay current.
  entries: readonly GitStatusEntry[]
}

export type UseSourceControlSubmoduleStatusResult = {
  expandedSubmoduleKeys: Set<string>
  submoduleStatusByKey: Record<string, SubmoduleStatusState>
  toggleSubmodule: (entry: Pick<GitStatusEntry, 'area' | 'path'>) => void
}

/** Load inner status only for expanded submodules so parent polling never recurses. */
export function useSourceControlSubmoduleStatus(
  input: UseSourceControlSubmoduleStatusInput
): UseSourceControlSubmoduleStatusResult {
  const { activeWorktreeId, worktreePath, activeRepoTarget, entries } = input
  const [expandedSubmoduleKeys, setExpandedSubmoduleKeys] = useState<Set<string>>(() => new Set())
  const activeRuntimeRouteKey =
    activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : ''
  const activeConnectionRouteKey = getConnectionId(activeWorktreeId ?? null) ?? ''
  const submoduleStatusScopeKey = `${activeConnectionRouteKey}\0${activeRuntimeRouteKey}\0${activeWorktreeId ?? ''}\0${worktreePath ?? ''}`
  // Store scope with results so late previous-host/worktree updates can no-op without render-time refs.
  const [submoduleStatusStore, setSubmoduleStatusStore] = useState<{
    scope: string
    byKey: Record<string, SubmoduleStatusState>
  }>(() => ({ scope: submoduleStatusScopeKey, byKey: {} }))
  // Reset during render so host/worktree switches cannot paint the prior expansion.
  if (submoduleStatusStore.scope !== submoduleStatusScopeKey) {
    setSubmoduleStatusStore({ scope: submoduleStatusScopeKey, byKey: {} })
    setExpandedSubmoduleKeys(new Set())
  }
  const submoduleStatusByKey = submoduleStatusStore.byKey

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
      const scopeAtStart = submoduleStatusScopeKey
      // Retain loaded children during poll refreshes to avoid flashing a loading placeholder.
      setSubmoduleStatusStore((prev) =>
        prev.scope !== scopeAtStart || prev.byKey[expansionKey]
          ? prev
          : {
              ...prev,
              byKey: { ...prev.byKey, [expansionKey]: { status: 'loading' } }
            }
      )
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        const result = await getRuntimeGitSubmoduleStatus(
          {
            // Use the repo owner like the rest of the panel.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          submodulePath,
          area
        )
        setSubmoduleStatusStore((prev) =>
          prev.scope !== scopeAtStart
            ? prev
            : {
                ...prev,
                byKey: {
                  ...prev.byKey,
                  [expansionKey]: {
                    status: 'loaded',
                    entries: result.entries,
                    ...(result.didHitLimit ? { didHitLimit: true } : {})
                  }
                }
              }
        )
      } catch (error) {
        setSubmoduleStatusStore((prev) =>
          prev.scope !== scopeAtStart ||
          // A poll refused for a stopped WSL distro keeps the children already shown.
          (prev.byKey[expansionKey]?.status === 'loaded' && isWslDistroNotRunningRefusal(error))
            ? prev
            : {
                ...prev,
                byKey: {
                  ...prev.byKey,
                  [expansionKey]: {
                    status: 'error',
                    error: error instanceof Error ? error.message : String(error)
                  }
                }
              }
        )
      }
    },
    [activeRepoTarget, activeWorktreeId, submoduleStatusScopeKey, worktreePath]
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

  // Refresh expanded children when parent entries change; collapsed submodules incur no Git work.
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
