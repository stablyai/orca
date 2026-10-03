import { useEffect } from 'react'
import { retryAllRemoteRuntimePtyRecoveriesNow } from '@/components/terminal-pane/remote-runtime-pty-recovery-state'
import { useAppStore } from '../store'
import type { AppState } from '../store'

type RuntimeStatusEntries = AppState['runtimeStatusByEnvironmentId']

/**
 * True when any environment gained a status or advanced its connection generation.
 *
 * Why this trigger exists at all: a paired runtime returning is invisible to `online` and
 * system-resume — a tailnet or VPN coming back changes neither `navigator.onLine` (the LAN never
 * dropped) nor power state, so a parked pane would wait for a manual Reconnect forever.
 */
function hasEnvironmentBecomeReachable(
  next: RuntimeStatusEntries,
  previous: RuntimeStatusEntries
): boolean {
  if (next === previous) {
    return false
  }
  for (const [environmentId, entry] of next) {
    if (entry.status == null) {
      continue
    }
    const before = previous.get(environmentId)
    if (before?.status == null) {
      return true
    }
    if ((entry.connectionGeneration ?? 0) > (before.connectionGeneration ?? 0)) {
      return true
    }
  }
  return false
}

/** Advances parked remote-runtime backoffs when the network, the machine, or an environment returns. */
export function useRemoteRuntimeRecoveryTriggers(): void {
  useEffect(() => {
    /** Nudges both backoff owners at once. */
    const advanceRemoteRuntimeRecoveryBackoffs = (): void => {
      // Why: shared control and pane recovery own independent backoff timers.
      void window.api?.runtimeEnvironments?.retryConnectionsNow?.().catch(() => undefined)
      retryAllRemoteRuntimePtyRecoveriesNow()
    }
    window.addEventListener('online', advanceRemoteRuntimeRecoveryBackoffs)
    const unsubscribeSystemResumed =
      typeof window.api?.ui?.onSystemResumed === 'function'
        ? window.api.ui.onSystemResumed(advanceRemoteRuntimeRecoveryBackoffs)
        : null
    // Why: setRuntimeEnvironmentStatus suppresses no-op re-probe writes, so this only fires on a real
    // transition rather than on every poll.
    const unsubscribeRuntimeStatus = useAppStore.subscribe((state, previousState) => {
      if (
        hasEnvironmentBecomeReachable(
          state.runtimeStatusByEnvironmentId,
          previousState.runtimeStatusByEnvironmentId
        )
      ) {
        retryAllRemoteRuntimePtyRecoveriesNow()
      }
    })
    return () => {
      window.removeEventListener('online', advanceRemoteRuntimeRecoveryBackoffs)
      unsubscribeSystemResumed?.()
      unsubscribeRuntimeStatus()
    }
  }, [])
}
