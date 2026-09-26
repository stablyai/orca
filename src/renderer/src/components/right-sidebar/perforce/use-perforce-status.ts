import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  PerforceOperationResult,
  PerforceStatusResult
} from '../../../../../shared/perforce/perforce-types'

const REFRESH_INTERVAL_MS = 15_000

export type PerforceTarget = { worktreePath: string; connectionId?: string }

export function usePerforceStatus(target: PerforceTarget) {
  const { worktreePath, connectionId } = target
  const [status, setStatus] = useState<PerforceStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const id = ++requestId.current
    try {
      const next = await window.api.perforce.status({ worktreePath, connectionId })
      if (id === requestId.current) {
        setStatus(next)
        setError(null)
      }
    } catch (caught) {
      if (id === requestId.current) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }, [worktreePath, connectionId])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  /** Runs a p4 mutation, surfaces failures as a toast, and refreshes afterwards. */
  const run = useCallback(
    async (operation: () => Promise<PerforceOperationResult>, successMessage?: string) => {
      setBusy(true)
      try {
        const result = await operation()
        if (!result.success) {
          toast.error(result.error ?? 'Perforce command failed')
        } else if (successMessage) {
          toast.success(successMessage, result.output ? { description: result.output } : undefined)
        }
        return result.success
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : String(caught))
        return false
      } finally {
        setBusy(false)
        void refresh()
      }
    },
    [refresh]
  )

  return { status, error, busy, refresh, run }
}
