import { useEffect, useMemo } from 'react'
import type { GitConflictOperation, Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitConflictOperation } from '@/runtime/runtime-git-client'
import { createCoalescedPollRunner, type SlowTaskBackoffOptions } from './coalesced-poll-runner'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

const CONFLICT_POLL_INTERVAL_MS = 3000

/**
 * Polls the conflict operation of non-active worktrees whose sidebar badge
 * still shows merge/rebase/cherry-pick, so the badge clears when the operation
 * finishes. This is a lightweight fs-only check (no git status), so it stays
 * cheap even with many worktrees.
 */
export function useStaleConflictOperationPolling(args: {
  enabled: boolean
  activeWorktreeId: string | null
  allWorktrees: { id: string; path: string; repoId: string }[]
  repoMap: Map<string, Pick<Repo, 'kind'>>
  conflictOperationByWorktree: Record<string, GitConflictOperation>
  setConflictOperation: (worktreeId: string, operation: GitConflictOperation) => void
  isConnectionReady: (connectionId: string | null | undefined) => boolean
  slowTaskBackoff: SlowTaskBackoffOptions
}): void {
  const {
    enabled,
    activeWorktreeId,
    allWorktrees,
    repoMap,
    conflictOperationByWorktree,
    setConflictOperation,
    isConnectionReady,
    slowTaskBackoff
  } = args
  // Why: only non-active worktrees with a known conflict operation need this
  // probe — the full git status refresh already covers the active worktree.
  const staleConflictWorktrees = useMemo(() => {
    const result: { id: string; path: string }[] = []
    for (const [worktreeId, op] of Object.entries(conflictOperationByWorktree)) {
      if (worktreeId === activeWorktreeId || op === 'unknown') {
        continue
      }
      const worktree = allWorktrees.find((entry) => entry.id === worktreeId)
      if (worktree) {
        const repo = repoMap.get(worktree.repoId)
        if (repo && !isGitRepoKind(repo)) {
          continue
        }
        result.push({ id: worktree.id, path: worktree.path })
      }
    }
    return result
  }, [allWorktrees, conflictOperationByWorktree, activeWorktreeId, repoMap])
  useEffect(() => {
    if (!enabled) {
      return
    }
    if (staleConflictWorktrees.length === 0) {
      return
    }

    // Why: dispose() cannot interrupt an in-flight probe; without this guard a
    // request resolving after cleanup would overwrite newer conflict state.
    let active = true

    const pollStale = async (): Promise<void> => {
      // Why: a backoff-deferred run can fire long after the window hides; skip
      // the probe instead of running SSH/RPC work nobody can see. The
      // becoming-visible run catches up via the change-signal lane.
      if (!isWindowVisible()) {
        return
      }
      for (const { id, path } of staleConflictWorktrees) {
        try {
          const connectionId = getConnectionId(id) ?? undefined
          // Why: after explicit SSH disconnect the provider is intentionally
          // gone; keep remote polling quiet until the target reconnects.
          if (!isConnectionReady(connectionId)) {
            continue
          }
          const op = (await getRuntimeGitConflictOperation({
            settings: getRightSidebarWorktreeRuntimeSettings(id),
            worktreeId: id,
            worktreePath: path,
            connectionId
          })) as GitConflictOperation
          if (!active) {
            return
          }
          setConflictOperation(id, op)
        } catch {
          // ignore — worktree may have been removed
        }
      }
    }

    // Why: remote conflict probes can exceed the 3s interval. Keep one poll in
    // flight, coalesce skipped ticks into one trailing pass, and back off after
    // slow probe chains so stale badges catch up without stacking SSH/RPC work.
    const pollRunner = createCoalescedPollRunner(pollStale, {
      slowTaskBackoff
    })
    // Why: conflict badges are visible sidebar state; keep them fresh in
    // visible unfocused windows, but do not poll disconnected hidden windows.
    // The becoming-visible run rides the short-backoff lane so badges catch
    // up promptly after a hidden stretch.
    const stopVisiblePoll = installWindowVisibilityInterval({
      run: () => pollRunner.run(),
      runOnVisible: () => pollRunner.run({ changeSignal: true }),
      intervalMs: CONFLICT_POLL_INTERVAL_MS
    })
    return () => {
      active = false
      pollRunner.dispose()
      stopVisiblePoll()
    }
  }, [enabled, staleConflictWorktrees, setConflictOperation, isConnectionReady, slowTaskBackoff])
}
