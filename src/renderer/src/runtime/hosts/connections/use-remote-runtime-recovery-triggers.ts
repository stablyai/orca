import { useEffect } from 'react'
import { retryAllRemoteRuntimePtyRecoveriesNow } from '@/components/terminal-pane/pty-transport/remote-runtime/recovery/remote-runtime-pty-recovery-state'
import { reviveRemoteRuntimePtyRecoveriesForEnvironment } from '@/components/terminal-pane/pty-transport/remote-runtime/recovery/remote-runtime-pty-control-ready-revivers'

export function useRemoteRuntimeRecoveryTriggers(): void {
  useEffect(() => {
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
    const readyByEnvironment = new Map<string, boolean>()
    const unsubscribeControlDiagnostics =
      typeof window.api?.runtimeEnvironments?.onSharedControlDiagnostics === 'function'
        ? window.api.runtimeEnvironments.onSharedControlDiagnostics(
            ({ environmentId, diagnostics }) => {
              const ready = diagnostics.state === 'ready'
              const wasReady = readyByEnvironment.get(environmentId) ?? false
              readyByEnvironment.set(environmentId, ready)
              if (ready && !wasReady) {
                reviveRemoteRuntimePtyRecoveriesForEnvironment(environmentId)
              }
            }
          )
        : null
    return () => {
      window.removeEventListener('online', advanceRemoteRuntimeRecoveryBackoffs)
      unsubscribeSystemResumed?.()
      unsubscribeControlDiagnostics?.()
    }
  }, [])
}
