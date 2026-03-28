import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { GitStatusEntry } from '../../../../shared/types'

const POLL_INTERVAL_MS = 3000

export function useGitStatusPolling(): void {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const setGitStatus = useAppStore((s) => s.setGitStatus)

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

  const fetchStatus = useCallback(async () => {
    if (!activeWorktreeId || !worktreePath) {
      return
    }
    try {
      const entries = (await window.api.git.status({ worktreePath })) as GitStatusEntry[]
      setGitStatus(activeWorktreeId, entries)
    } catch {
      // ignore
    }
  }, [activeWorktreeId, worktreePath, setGitStatus])

  useEffect(() => {
    void fetchStatus()
    const intervalId = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS)
    return () => clearInterval(intervalId)
  }, [fetchStatus])
}
