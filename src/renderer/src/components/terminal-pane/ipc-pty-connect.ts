import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { ensurePtyDispatcher } from './pty-dispatcher'
import {
  clearConsumedPreHandlerPtyExit,
  hasPreHandlerPtyExit,
  isPreHandlerPtyStateDiscarded
} from './pty-pre-handler-buffer'
import { projectIpcPtyConnectResult } from './ipc-pty-connect-result'
import { waitAtTerminalPtyPreSpawnE2EBarrier } from './terminal-pty-pre-spawn-e2e-barrier'
import type { IpcPtySessionHandlers } from './ipc-pty-session-handlers'
import { spawnIpcPty } from './ipc-pty-spawn-request'
import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'

const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
const SSH_PTY_CONNECTION_MISMATCH_MARKER = 'belongs to SSH connection'

type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]

type IpcPtyConnectContext = {
  transportOptions: IpcPtyTransportOptions
  handlers: IpcPtySessionHandlers
  isDestroyed: () => boolean
  bind: (id: string) => void
  isCurrent: (id: string) => boolean
  setCallbacks: (callbacks: PtyConnectOptions['callbacks']) => void
  getCallbacks: () => PtyConnectOptions['callbacks']
}

export async function connectIpcPty(
  options: PtyConnectOptions,
  context: IpcPtyConnectContext
): Promise<void | string | PtyConnectResult> {
  const { transportOptions, handlers } = context
  const { onPtySpawn } = transportOptions
  context.setCallbacks(options.callbacks)
  ensurePtyDispatcher()

  if (context.isDestroyed()) {
    return
  }
  if (options.sessionId && hasPreHandlerPtyExit(options.sessionId)) {
    if (options.admitPtyId && !options.admitPtyId(options.sessionId)) {
      return { id: options.sessionId }
    }
    context.bind(options.sessionId)
    handlers.registerData(options.sessionId)
    handlers.registerExit(options.sessionId)
    return { id: options.sessionId, exitedBeforeAttach: true }
  }

  const admittedSessionId =
    options.sessionId && !isPreHandlerPtyStateDiscarded(options.sessionId)
      ? options.sessionId
      : undefined
  if (admittedSessionId) {
    clearConsumedPreHandlerPtyExit(admittedSessionId)
  }

  try {
    const preSpawnBarrier = waitAtTerminalPtyPreSpawnE2EBarrier()
    if (preSpawnBarrier) {
      await preSpawnBarrier
      if (context.isDestroyed()) {
        return
      }
    }
    if (options.shouldContinue && !options.shouldContinue()) {
      return
    }
    const spawnResult = await spawnIpcPty(transportOptions, options, admittedSessionId)
    const retireFreshSpawn = async (): Promise<void> => {
      if (!spawnResult.isReattach && !spawnResult.coldRestore) {
        await window.api.pty.kill(spawnResult.id)
      }
    }

    if (context.isDestroyed()) {
      await retireFreshSpawn()
      return
    }
    if (options.admitPtyId && !options.admitPtyId(spawnResult.id)) {
      await retireFreshSpawn()
      return spawnResult
    }
    if (spawnResult.isReattach && !admittedSessionId) {
      context.getCallbacks().onReattachDetermined?.()
    }

    context.bind(spawnResult.id)
    if (!spawnResult.isReattach && !spawnResult.coldRestore) {
      onPtySpawn?.(spawnResult.id)
    }
    handlers.registerData(spawnResult.id)
    const exitedBeforeAttach = handlers.registerExit(spawnResult.id)
    if (exitedBeforeAttach) {
      return { id: spawnResult.id, exitedBeforeAttach: true }
    }
    if (!context.isCurrent(spawnResult.id)) {
      return
    }

    context.getCallbacks().onConnect?.()
    context.getCallbacks().onStatus?.('shell')
    return projectIpcPtyConnectResult(spawnResult)
  } catch (error) {
    return handleConnectError(error, options, context)
  }
}

function handleConnectError(
  error: unknown,
  options: PtyConnectOptions,
  context: IpcPtyConnectContext
): PtyConnectResult | undefined {
  const { connectionId } = context.transportOptions
  const message = extractIpcErrorMessage(
    error,
    error instanceof Error ? error.message : String(error)
  )
  if (
    connectionId &&
    options.sessionId &&
    (message.includes(SSH_SESSION_EXPIRED_ERROR) ||
      message.includes(SSH_PTY_CONNECTION_MISMATCH_MARKER))
  ) {
    return { id: options.sessionId, sessionExpired: true }
  }
  if (message.includes('was explicitly killed')) {
    return undefined
  }
  if (connectionId && message.includes('No PTY provider for connection')) {
    if (!isRuntimeOwnedSshTargetId(connectionId)) {
      context
        .getCallbacks()
        .onError?.('SSH connection is not active. Use the reconnect dialog or Settings to connect.')
    }
  } else {
    context.getCallbacks().onError?.(message)
  }
  return undefined
}
