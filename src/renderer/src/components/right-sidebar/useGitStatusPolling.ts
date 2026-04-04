import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { GitConflictOperation, GitStatusResult } from '../../../../shared/types'

const POLL_INTERVAL_MS = 3000

export function useGitStatusPolling(): void {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const setConflictOperation = useAppStore((s) => s.setConflictOperation)
  const conflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)

  const worktreePath = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

  const activeRepoId = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
      if (worktrees.some((wt) => wt.id === activeWorktreeId)) {
        return repoId
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

  // Why: build a list of non-active worktrees that still have a known conflict
  // operation (merge/rebase/cherry-pick). These need lightweight polling so
  // their sidebar badges clear when the operation finishes — the full git status
  // poll only covers the active worktree.
  const staleConflictWorktrees = useMemo(() => {
    const result: { id: string; path: string }[] = []
    for (const [worktreeId, op] of Object.entries(conflictOperationByWorktree)) {
      if (worktreeId === activeWorktreeId || op === 'unknown') {
        continue
      }
      for (const worktrees of Object.values(worktreesByRepo)) {
        const wt = worktrees.find((w) => w.id === worktreeId)
        if (wt) {
          result.push({ id: wt.id, path: wt.path })
          break
        }
      }
    }
    return result
  }, [conflictOperationByWorktree, activeWorktreeId, worktreesByRepo])

  const fetchStatus = useCallback(async () => {
    if (!activeWorktreeId || !worktreePath) {
      return
    }
    try {
      const status = (await window.api.git.status({ worktreePath })) as GitStatusResult
      setGitStatus(activeWorktreeId, status)
    } catch {
      // ignore
    }
  }, [activeWorktreeId, worktreePath, setGitStatus])

  useEffect(() => {
    void fetchStatus()
    const intervalId = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS)
    return () => clearInterval(intervalId)
  }, [fetchStatus])

  useEffect(() => {
    if (!activeRepoId) {
      return
    }

    // Why: checkout/switch operations happen inside the terminal, outside the
    // renderer's normal worktree-change events. Poll the active repo's worktree
    // list so a branch change updates the sidebar's PR key instead of leaving
    // the previous merged PR attached to this worktree indefinitely.
    void fetchWorktrees(activeRepoId)
    const intervalId = setInterval(() => void fetchWorktrees(activeRepoId), POLL_INTERVAL_MS)
    return () => clearInterval(intervalId)
  }, [activeRepoId, fetchWorktrees])

  // Why: poll conflict operation for non-active worktrees that have a stale
  // non-unknown operation. This is a lightweight fs-only check (no git status)
  // so it won't cause performance issues even with many worktrees.
  useEffect(() => {
    if (staleConflictWorktrees.length === 0) {
      return
    }

    const pollStale = async (): Promise<void> => {
      for (const { id, path } of staleConflictWorktrees) {
        try {
          const op = (await window.api.git.conflictOperation({
            worktreePath: path
          })) as GitConflictOperation
          setConflictOperation(id, op)
        } catch {
          // ignore — worktree may have been removed
        }
      }
    }

    void pollStale()
    const intervalId = setInterval(() => void pollStale(), POLL_INTERVAL_MS)
    return () => clearInterval(intervalId)
  }, [staleConflictWorktrees, setConflictOperation])
}
