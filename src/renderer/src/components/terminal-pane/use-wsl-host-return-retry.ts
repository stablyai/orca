import { useEffect, useRef } from 'react'
import type { WslHostConnectionState } from '../../../../shared/wsl-host-types'
import type { PtyTransport } from './pty-transport-types'

/**
 * A pane that met its WSL host stopped gave up; Start revives it, but so must the host coming back
 * on its own (started elsewhere), or the pane stays dead under a stale error once the card goes.
 */
export function useRetryPanesWhenWslHostReturns(
  ownerEnvironmentId: string | null,
  /** The owner's WSL host state, from the caller's own subscription (no listener of its own). */
  status: WslHostConnectionState | undefined,
  paneTransports: { readonly current: ReadonlyMap<number, PtyTransport> }
): void {
  const stoppedHost = useRef<string | null>(null)
  useEffect(() => {
    if (status === 'distro-stopped') {
      stoppedHost.current = ownerEnvironmentId
      return
    }
    if (status !== 'ready' || !ownerEnvironmentId || stoppedHost.current !== ownerEnvironmentId) {
      return
    }
    stoppedHost.current = null
    for (const transport of paneTransports.current.values()) {
      // The card's rule: a pane with no server yet is still the workspace's; one on another never met this stop.
      const paneEnvironmentId = transport.getRuntimeEnvironmentId
        ? transport.getRuntimeEnvironmentId()
        : ownerEnvironmentId
      if (paneEnvironmentId == null || paneEnvironmentId === ownerEnvironmentId) {
        transport.retryRecovery?.()
      }
    }
  }, [status, ownerEnvironmentId, paneTransports])
}
