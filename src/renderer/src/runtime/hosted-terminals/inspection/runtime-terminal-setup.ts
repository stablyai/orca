import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import type { TerminalSetupStatus } from '../../../../../shared/terminal/pty/lifecycle/terminal-setup-status'
import { classifyTerminalProcessInspectionFailure } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE } from '../../../../../shared/remote-runtime/remote-runtime-connect-bound'
import { toRemoteRuntimeClientErrorLike } from '../../../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { getRemoteRuntimePtyOwner } from '../identity/remote-runtime-pty-owner'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { TerminalSetupObservers } from './terminal-setup-observers'

export const terminalSetupObservers = new TerminalSetupObservers()
let localObservers = 0
let stopLocal: (() => void) | undefined
const activeStreams = new Map<string, { restart: () => void }>()

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
        const stream = activeStreams.get(owner.target.environmentId)
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
            stream?.restart()
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
  let closed = false
  let handle: { unsubscribe: () => void } | undefined
  const isActive = (): boolean => !closed && activeStreams.get(scope) === owner
  const releaseHandle = (): void => {
    const retained = handle
    handle = undefined
    retained?.unsubscribe()
  }
  const disconnect = (): void => {
    if (isActive()) {
      terminalSetupObservers.setConnected(scope, false)
    }
  }
  const close = (notify: boolean): void => {
    if (closed) {
      return
    }
    const active = isActive()
    closed = true
    if (active) {
      activeStreams.delete(scope)
      terminalSetupObservers.setConnected(scope, false)
    }
    try {
      if (notify) {
        onClose()
      }
    } finally {
      releaseHandle()
    }
  }
  const owner = {
    restart: () => {
      if (isActive() && isCurrent()) {
        close(true)
      }
    }
  }
  activeStreams.set(scope, owner)
  terminalSetupObservers.setConnected(scope, false)
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
      onClose: () => close(true)
    },
    retain: async (subscription: Promise<{ unsubscribe: () => void }>) => {
      try {
        handle = await subscription
      } catch (error) {
        close(false)
        throw error
      }
      if (closed) {
        releaseHandle()
      } else if (!isActive() || !isCurrent()) {
        close(false)
      }
      return { unsubscribe: () => close(false) }
    }
  }
}

function isSetupTransportLoss(error: unknown): boolean {
  const failure = toRemoteRuntimeClientErrorLike(error)
  if (failure.code) {
    return [
      'CONNECTION_LOST',
      'DISPOSED',
      'socket_closed',
      'connection_closed',
      'transport_closed',
      'remote_runtime_unavailable'
    ].includes(failure.code)
  }
  // Electron invoke rejections can strip the transport code before subscription starts.
  const message = failure.message.toLowerCase()
  return (
    message.includes(REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE.toLowerCase()) ||
    message.includes('remote orca runtime closed the connection') ||
    message.startsWith('runtime request closed before ')
  )
}
