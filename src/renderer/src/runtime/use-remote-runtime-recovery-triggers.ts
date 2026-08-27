import { useEffect } from 'react'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { retryAllRemoteRuntimePtyRecoveriesNow } from '@/components/terminal-pane/remote-runtime-pty-recovery-state'
import { useAppStore } from '@/store'
import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from './runtime-host-connection-state'
import {
  retryRuntimeStatusRecoveryProbesNow,
  startRuntimeStatusRecoveryProbe
} from './runtime-status-recovery-probe'

function isDisconnectedRuntimeEnvironment(
  entry: { status: RuntimeStatus | null } | undefined
): boolean {
  return isDisconnectedRuntimeHostState(runtimeHostConnectionStateForEntry(entry))
}

export function useRemoteRuntimeRecoveryTriggers(): void {
  useEffect(() => {
    const stopStatusRecoveryProbe = startRuntimeStatusRecoveryProbe({
      isRuntimeEnvironmentDisconnected: (environmentId) =>
        isDisconnectedRuntimeEnvironment(
          useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
        ),
      listDisconnectedRuntimeEnvironmentIds: () =>
        [...useAppStore.getState().runtimeStatusByEnvironmentId]
          .filter(([, entry]) => isDisconnectedRuntimeEnvironment(entry))
          .map(([environmentId]) => environmentId),
      // Optional-chained, and 'superseded' when absent: a store assembly without the slice
      // never asked the host, so the loop must learn nothing rather than count a failure.
      refreshRuntimeEnvironmentStatus: (environmentId) =>
        useAppStore.getState().refreshRuntimeEnvironmentStatusOutcome?.(environmentId) ??
        Promise.resolve('superseded' as const),
      subscribeToRecordedStatusChanges: (onChange) =>
        useAppStore.subscribe((state, previous) => {
          // The slice replaces the map only on a real transition, so the reference
          // gate keeps unrelated store writes out of the probe scheduler.
          if (state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId) {
            onChange()
          }
        })
    })
    const advanceRemoteRuntimeRecoveryBackoffs = (): void => {
      // Why: shared control, pane recovery, and status re-probing own independent backoff timers.
      void window.api?.runtimeEnvironments?.retryConnectionsNow?.().catch(() => undefined)
      retryAllRemoteRuntimePtyRecoveriesNow()
      retryRuntimeStatusRecoveryProbesNow()
    }
    window.addEventListener('online', advanceRemoteRuntimeRecoveryBackoffs)
    const unsubscribeSystemResumed =
      typeof window.api?.ui?.onSystemResumed === 'function'
        ? window.api.ui.onSystemResumed(advanceRemoteRuntimeRecoveryBackoffs)
        : null
    return () => {
      window.removeEventListener('online', advanceRemoteRuntimeRecoveryBackoffs)
      unsubscribeSystemResumed?.()
      stopStatusRecoveryProbe()
    }
  }, [])
}
