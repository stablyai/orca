import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import type { TerminalSetupStatus } from '../../../../../shared/terminal/pty/lifecycle/terminal-setup-status'
import { classifyTerminalProcessInspectionFailure } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
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
          if (classifyTerminalProcessInspectionFailure(error) === 'old_host') {
            return null
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
  onClose: () => void
) {
  const owner = Symbol(scope)
  activeStreams.set(scope, owner)
  terminalSetupObservers.setConnected(scope, false)
  const disconnect = (): void => {
    if (activeStreams.get(scope) === owner) {
      terminalSetupObservers.setConnected(scope, false)
    }
  }
  return {
    callbacks: {
      onReady: () => {
        if (isCurrent() && activeStreams.get(scope) === owner) {
          terminalSetupObservers.setConnected(scope, true)
        }
      },
      onClose: () => {
        disconnect()
        onClose()
      }
    },
    retain: async (subscription: Promise<{ unsubscribe: () => void }>) => {
      const handle = await subscription
      return {
        unsubscribe: () => {
          disconnect()
          if (activeStreams.get(scope) === owner) {
            activeStreams.delete(scope)
          }
          handle.unsubscribe()
        }
      }
    }
  }
}
