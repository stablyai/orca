import { useEffect, useMemo } from 'react'
import type { GitConflictOperation } from '../../../../shared/git-status-types'
import type { Repo } from '../../../../shared/repo-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitConflictOperation } from '@/runtime/runtime-git-status-client'
import { createCoalescedPollRunner, type SlowTaskBackoffOptions } from './coalesced-poll-runner'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { getWorktreeGitOwnerTarget } from './worktree-git-owner-target'

const CONFLICT_POLL_INTERVAL_MS = 3000

/** Clear inactive-worktree conflict badges through cheap filesystem probes without Git status. */
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
  // Active worktrees already receive full Git status refreshes.
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

    // dispose cannot interrupt in-flight probes; reject results after cleanup.
    let active = true

    const pollStale = async (): Promise<void> => {
      // Backoff may fire after hiding; skip invisible SSH/RPC work and catch up when visible.
      if (!isWindowVisible()) {
        return
      }
      for (const { id, path } of staleConflictWorktrees) {
        if (!active || !isWindowVisible()) {
          return
        }
        try {
          const connectionId = getConnectionId(id) ?? undefined
          // Explicit SSH disconnect removes the provider; wait for reconnection before probing.
          const target = getWorktreeGitOwnerTarget(id)
          if (!isConnectionReady(connectionId) || !target) {
            continue
          }
          const op = await getRuntimeGitConflictOperation({
            target,
            worktreeId: id,
            worktreePath: path,
            connectionId
          })
          if (!active) {
            return
          }
          setConflictOperation(id, op)
        } catch {
          // Worktrees may disappear during the probe.
        }
      }
    }

    // Coalesce slow remote probes and back off to prevent overlapping SSH/RPC chains.
    const pollRunner = createCoalescedPollRunner(pollStale, {
      slowTaskBackoff
    })
    // Refresh visible unfocused badges; visibility recovery uses the short-backoff lane.
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
