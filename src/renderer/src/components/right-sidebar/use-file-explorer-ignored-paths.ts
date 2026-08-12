import { useEffect, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitIgnoredPaths } from '@/runtime/runtime-git-client'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

const EMPTY_IGNORED_PATHS: readonly string[] = []
export const FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS = 300

export type IgnoredPathResult = {
  activeWorktreeId: string
  paths: string[]
  worktreePath: string
}

export function getEffectiveFileExplorerIgnoredPaths({
  activeWorktreeId,
  canLoadIgnoredPaths,
  ignoredPathResult,
  worktreePath
}: {
  activeWorktreeId: string | null
  canLoadIgnoredPaths: boolean
  ignoredPathResult: IgnoredPathResult | null
  worktreePath: string | null
}): readonly string[] {
  const ignoredPathResultMatchesCurrentWorktree =
    ignoredPathResult !== null &&
    ignoredPathResult.activeWorktreeId === activeWorktreeId &&
    ignoredPathResult.worktreePath === worktreePath

  if (!canLoadIgnoredPaths || !ignoredPathResultMatchesCurrentWorktree) {
    return EMPTY_IGNORED_PATHS
  }

  // Why: expanding folders changes the query before the async ignored refresh returns.
  // Keep same-worktree answers so known ignored rows do not flash as normal text.
  return ignoredPathResult.paths
}

export function useFileExplorerIgnoredPaths({
  activeWorktreeId,
  canLoadIgnoredPaths,
  relativePaths,
  shouldDebounceIgnoredQuery,
  worktreePath
}: {
  activeWorktreeId: string | null
  canLoadIgnoredPaths: boolean
  relativePaths: readonly string[]
  shouldDebounceIgnoredQuery: boolean
  worktreePath: string | null
}): readonly string[] {
  const [ignoredPathResult, setIgnoredPathResult] = useState<IgnoredPathResult | null>(null)

  useEffect(() => {
    if (!canLoadIgnoredPaths || !activeWorktreeId || !worktreePath) {
      return
    }

    let canceled = false
    const refresh = (): void => {
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      void getRuntimeGitIgnoredPaths(
        {
          settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        [...relativePaths]
      )
        .then((paths) => {
          if (!canceled) {
            setIgnoredPathResult({ activeWorktreeId, paths, worktreePath })
          }
        })
        .catch(() => {
          if (!canceled) {
            setIgnoredPathResult({ activeWorktreeId, paths: [], worktreePath })
          }
        })
    }

    // Why: every filter keystroke changes relativePaths. Waiting for a short
    // quiet window prevents obsolete queries from launching uncancellable Git
    // subprocess chains while the visible name projection stays immediate.
    const timer = shouldDebounceIgnoredQuery
      ? window.setTimeout(refresh, FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS)
      : null
    if (timer === null) {
      refresh()
    }

    return () => {
      canceled = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [
    activeWorktreeId,
    canLoadIgnoredPaths,
    relativePaths,
    shouldDebounceIgnoredQuery,
    worktreePath
  ])

  return getEffectiveFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths,
    ignoredPathResult,
    worktreePath
  })
}
