import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'
import type { DaemonSession } from './resource-usage-merge-types'

export type OrphanKillGate = {
  pending: DaemonSession[] | null
  isKilling: boolean
  request: (orphans: DaemonSession[]) => void
  cancel: () => void
  confirm: () => Promise<void>
}

/**
 * Confirmation gate for the bulk "kill N orphan terminals" sweep. `request`
 * only stages the snapshot; PTYs are killed strictly from `confirm`, so the
 * mass-kill never fires without an explicit confirmation (issue #9949).
 */
export function useOrphanKillGate({
  setSessions,
  refreshSessions,
  getBoundPtyIds
}: {
  setSessions: Dispatch<SetStateAction<DaemonSession[]>>
  refreshSessions: () => void
  getBoundPtyIds: () => ReadonlySet<string>
}): OrphanKillGate {
  const [pending, setPending] = useState<DaemonSession[] | null>(null)
  const [isKilling, setIsKilling] = useState(false)
  const mountedRef = useMountedRef()

  const request = useCallback((orphans: DaemonSession[]): void => {
    if (orphans.length === 0) {
      return
    }
    setPending(orphans)
  }, [])

  const cancel = useCallback((): void => {
    setPending(null)
  }, [])

  const confirm = useCallback(async (): Promise<void> => {
    if (!pending) {
      return
    }
    // Why: a session adopted by a tab while the dialog sat open is no longer an orphan; re-filter live bindings so it is never killed (issue #9949).
    const bound = getBoundPtyIds()
    const orphans = pending.filter((s) => !bound.has(s.id))
    if (orphans.length === 0) {
      setPending(null)
      return
    }
    setIsKilling(true)
    // Why: attribution breadcrumb for #9949 mass-kill; best-effort, must never block the kill.
    recordRendererCrashBreadcrumb('terminal_mass_kill', {
      source: 'orphan-sweep',
      count: orphans.length
    })
    const orphanIds = new Set(orphans.map((s) => s.id))
    // Why: optimistic removal so rows disappear immediately instead of waiting for the next daemon-side list refresh.
    setSessions((prev) => prev.filter((s) => !orphanIds.has(s.id)))
    await Promise.allSettled(orphans.map((s) => window.api.pty.kill(s.id)))
    if (mountedRef.current) {
      setIsKilling(false)
      setPending(null)
      refreshSessions()
    }
  }, [pending, setSessions, refreshSessions, getBoundPtyIds, mountedRef])

  return { pending, isKilling, request, cancel, confirm }
}
