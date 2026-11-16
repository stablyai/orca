import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import type { TerminalSetupStatus } from '../../../../../shared/terminal/pty/lifecycle/terminal-setup-status'
import { classifyTerminalProcessInspectionFailure } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { toRemoteRuntimeClientErrorLike } from '../../../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { getRemoteRuntimePtyOwner } from '../identity/remote-runtime-pty-owner'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { TerminalSetupObservers } from './terminal-setup-observers'

export const terminalSetupObservers = new TerminalSetupObservers()
let localObservers = 0
let stopLocal: (() => void) | undefined
const activeStreams = new Map<string, symbol>()

export async function waitForRuntimeTerminalSetup(
  ptyId: string,
  signal?: AbortSignal
): Promise<void> {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (owner) {
    const revision = getRuntimeEnvironmentRevision(owner.target.environmentId)
    return terminalSetupObservers.wait(
      owner.target.environmentId,
      owner.terminal,
      async (readSignal) => {
        try {
          return await callRuntimeRpc<TerminalSetupStatus>(
            owner.target,
            'terminal.setupStatus',
            { terminal: owner.terminal },
            { signal: readSignal, timeoutMs: 15_000, expectedEnvironmentPairingRevision: revision }
          )
        } catch (error) {
          const failure = classifyTerminalProcessInspectionFailure(error)
          if (failure === 'old_host') {
            return null
          }
          if (isSetupTransportLoss(error) && !readSignal.aborted) {
            terminalSetupObservers.setConnected(owner.target.environmentId, false)
          }
          throw error
        }
      },
      signal
    )
  }
  if (!window.api.pty.setupStatus || !window.api.runtime?.onTerminalSetupChanged) {
    return
  }
  if (localObservers++ === 0) {
    stopLocal = window.api.runtime.onTerminalSetupChanged((status) =>
      terminalSetupObservers.changed('local', status)
    )
    terminalSetupObservers.setConnected('local', true)
  }
  try {
    await terminalSetupObservers.wait(
      'local',
      ptyId,
      async () => {
        try {
          return await window.api.pty.setupStatus!(ptyId)
        } catch (error) {
          if (classifyTerminalProcessInspectionFailure(error) === 'old_host') {
            return null
          }
          throw error
        }
      },
      signal
    )
  } finally {
    if (--localObservers === 0) {
      stopLocal?.()
      stopLocal = undefined
      terminalSetupObservers.setConnected('local', false)
    }
  }
}

export function withPendingTerminalSetupHosts(environmentIds: string[]): string[] {
  return [...new Set([...environmentIds, ...terminalSetupObservers.pendingScopes()])]
}

export function terminalSetupStreamLifecycle(
  scope: string,
  isCurrent: () => boolean,
  onClose: () => void,
  onError: (error: unknown) => void
) {
  const owner = Symbol(scope)
  activeStreams.set(scope, owner)
  terminalSetupObservers.setConnected(scope, false)
  const isActive = (): boolean => activeStreams.get(scope) === owner
  const disconnect = (): void => {
    if (isActive()) {
      terminalSetupObservers.setConnected(scope, false)
    }
  }
  const release = (): void => {
    disconnect()
    if (isActive()) {
      activeStreams.delete(scope)
    }
  }
  return {
    isActive,
    callbacks: {
      onReady: () => {
        if (isCurrent() && isActive()) {
          terminalSetupObservers.setConnected(scope, true)
        }
      },
      onError: (error: unknown) => {
        if (isSetupTransportLoss(error)) {
          disconnect()
        }
        onError(error)
      },
      onClose: () => {
        release()
        onClose()
      }
    },
    retain: async (subscription: Promise<{ unsubscribe: () => void }>) => {
      let handle: { unsubscribe: () => void }
      try {
        handle = await subscription
      } catch (error) {
        release()
        throw error
      }
      return {
        unsubscribe: () => {
          release()
          handle.unsubscribe()
        }
      }
    }
  }
}

function isSetupTransportLoss(error: unknown): boolean {
  const failure = toRemoteRuntimeClientErrorLike(error)
  // A live host also returns runtime_unavailable while its graph is reloading.
  return (
    failure.code !== 'runtime_unavailable' &&
    classifyTerminalProcessInspectionFailure(error) === 'transport_loss'
  )
}
