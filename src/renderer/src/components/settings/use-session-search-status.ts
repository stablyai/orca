import { useCallback, useEffect, useState } from 'react'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useWindowStreamVisible } from '@/hooks/use-window-stream-visibility'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { isHostTooOldError, sessionSearchPollIntervalMs } from './session-history-status-copy'

export type SessionSearchStatusRead = {
  status: AiVaultSearchStatus | null
  failed: boolean
  /** The host answered that it has no session search at all; polling stops. */
  hostTooOld: boolean
  /** Adopt a status the caller already holds, e.g. the answer to a set call. */
  adopt: (status: AiVaultSearchStatus) => void
}

/**
 * Polls one host's index status while the pane is visible: fast during a sweep,
 * slow once settled. An inactive host keeps its last answer, which is what an
 * offline row reports rather than inventing "off".
 */
export function useSessionSearchStatus(args: {
  executionHostId: ExecutionHostId
  active: boolean
  refresh?: number
}): SessionSearchStatusRead {
  const { executionHostId, active } = args
  const refresh = args.refresh ?? 0
  const visible = useWindowStreamVisible(0)
  const [status, setStatus] = useState<AiVaultSearchStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [hostTooOld, setHostTooOld] = useState(false)
  const intervalMs = sessionSearchPollIntervalMs(status)
  const adopt = useCallback((next: AiVaultSearchStatus) => {
    setStatus(next)
    setFailed(false)
  }, [])

  useEffect(() => {
    if (!active) {
      setFailed(false)
      return
    }
    if (!visible || hostTooOld) {
      return
    }
    let disposed = false
    let inFlight = false
    async function read(): Promise<void> {
      if (inFlight || disposed) {
        return
      }
      inFlight = true
      try {
        const next = await Promise.resolve().then(() =>
          window.api.aiVault.searchStatus(executionHostId)
        )
        if (!disposed) {
          setStatus(next)
          setFailed(false)
        }
      } catch (error) {
        if (!disposed) {
          setStatus(null)
          setFailed(true)
          if (isHostTooOldError(error)) {
            setHostTooOld(true)
          }
        }
      } finally {
        inFlight = false
      }
    }
    const stopPolling = installWindowVisibilityInterval({ run: () => void read(), intervalMs })
    return () => {
      disposed = true
      stopPolling()
    }
  }, [executionHostId, active, visible, refresh, intervalMs, hostTooOld])

  return { status, failed, hostTooOld, adopt }
}
