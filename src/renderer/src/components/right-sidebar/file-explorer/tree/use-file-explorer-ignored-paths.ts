import { useEffect, useState } from 'react'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { getRuntimeGitIgnoredPaths } from '@/runtime/source-control/git/runtime-git-status-client'
import { getWorktreeGitOwnerTarget } from '../../source-control/sync/worktree-git-owner-target'
import {
  createFileExplorerWorktreeSnapshots,
  fileExplorerWorktreeSnapshotKey
} from './file-explorer-worktree-snapshots'

const EMPTY_IGNORED_PATHS: readonly string[] = []
export const FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS = 300

export type IgnoredPathResult = {
  activeWorktreeId: string
  paths: string[]
  worktreePath: string
}

const lastIgnoredPathResults = createFileExplorerWorktreeSnapshots<IgnoredPathResult>()

function getEffectiveFileExplorerIgnoredPaths({
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
  if (!canLoadIgnoredPaths || !activeWorktreeId || !worktreePath) {
    return EMPTY_IGNORED_PATHS
  }
  // Same-host switches keep Files mounted, so fall back to this workspace's last answer until git replies.
  const result =
    ignoredPathResult?.activeWorktreeId === activeWorktreeId &&
    ignoredPathResult.worktreePath === worktreePath
      ? ignoredPathResult
      : lastIgnoredPathResults.peek(fileExplorerWorktreeSnapshotKey(activeWorktreeId, worktreePath))
  // Retain same-worktree answers while expanded-folder queries refresh to prevent ignored-row flashes.
  return result?.paths ?? EMPTY_IGNORED_PATHS
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
    const show = (paths: string[]): void => {
      const result = { activeWorktreeId, paths, worktreePath }
      lastIgnoredPathResults.keep(
        fileExplorerWorktreeSnapshotKey(activeWorktreeId, worktreePath),
        result
      )
      setIgnoredPathResult(result)
    }
    const refresh = (): void => {
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      const target = getWorktreeGitOwnerTarget(activeWorktreeId)
      if (!target) {
        return
      }
      void getRuntimeGitIgnoredPaths(
        {
          target,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        [...relativePaths]
      )
        .then((paths) => {
          if (!canceled) {
            show(paths)
          }
        })
        .catch(() => {
          if (!canceled) {
            show([])
          }
        })
    }

    // Debounce filter changes before launching uncancellable Git query chains; visible name filtering stays immediate.
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
