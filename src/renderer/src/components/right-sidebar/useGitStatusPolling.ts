import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { GitConflictOperation, GitStatusResult } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getConnectionId } from '@/lib/connection-context'

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
  const activeRepo = useAppStore((s) => s.repos.find((repo) => repo.id === activeRepoId) ?? null)
  const activeRepoSupportsGit = activeRepo ? isGitRepoKind(activeRepo) : false

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
          const repo = useAppStore.getState().repos.find((entry) => entry.id === wt.repoId)
          if (repo && !isGitRepoKind(repo)) {
            break
          }
          result.push({ id: wt.id, path: wt.path })
          break
        }
      }
    }
    return result
  }, [conflictOperationByWorktree, activeWorktreeId, worktreesByRepo])

  const fetchStatus = useCallback(async () => {
    if (!activeWorktreeId || !worktreePath || !activeRepoSupportsGit) {
      return
    }
    try {
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      const status = (await window.api.git.status({
        worktreePath,
        connectionId
      })) as GitStatusResult
      setGitStatus(activeWorktreeId, status)
    } catch {
      // ignore
    }
  }, [activeRepoSupportsGit, activeWorktreeId, worktreePath, setGitStatus])

  useEffect(() => {
    void fetchStatus()
    // Why: skip IPC-heavy git status calls when the window is not focused.
    // These intervals run at the App root level regardless of which sidebar tab
    // is open, so gating on document.hasFocus() prevents wasted CPU and IPC
    // traffic while the user is working in another application.
    const intervalId = setInterval(() => {
      if (document.hasFocus()) {
        void fetchStatus()
      }
    }, POLL_INTERVAL_MS)
    // Why: when the user returns to the window, poll immediately so the sidebar
    // shows up-to-date status without waiting up to POLL_INTERVAL_MS.
    const onFocus = (): void => void fetchStatus()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchStatus])

  useEffect(() => {
    if (!activeRepoId || !activeRepoSupportsGit) {
      return
    }

    // Why: checkout/switch operations happen inside the terminal, outside the
    // renderer's normal worktree-change events. Poll the active repo's worktree
    // list so a branch change updates the sidebar's PR key instead of leaving
    // the previous merged PR attached to this worktree indefinitely.
    void fetchWorktrees(activeRepoId)
    const intervalId = setInterval(() => {
      if (document.hasFocus()) {
        void fetchWorktrees(activeRepoId)
      }
    }, POLL_INTERVAL_MS)
    const onFocus = (): void => void fetchWorktrees(activeRepoId)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
    }
  }, [activeRepoId, activeRepoSupportsGit, fetchWorktrees])

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
            worktreePath: path,
            connectionId: getConnectionId(id) ?? undefined
          })) as GitConflictOperation
          setConflictOperation(id, op)
        } catch {
          // ignore — worktree may have been removed
        }
      }
    }

    void pollStale()
    const intervalId = setInterval(() => {
      if (document.hasFocus()) {
        void pollStale()
      }
    }, POLL_INTERVAL_MS)
    const onFocus = (): void => void pollStale()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
    }
  }, [staleConflictWorktrees, setConflictOperation])
}
