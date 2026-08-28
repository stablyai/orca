import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { ensurePtyDispatcher } from './pty-dispatcher'
import {
  clearConsumedPreHandlerPtyExit,
  currentPreHandlerPtySequence,
  discardPreHandlerPtyExitFromForeignIncarnation,
  discardPreHandlerPtyStateFromPriorIncarnation,
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
    // Why read it before the request and not after: a redeployed SSH relay renumbers from pty-1, so
    // this spawn can be handed an id a dead PTY used to own. State dated at or below this fence was
    // recorded before we asked for a PTY, so it belongs to that earlier owner, not to us.
    const priorIncarnationFence = currentPreHandlerPtySequence()
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

    // Why unconditional: this runs on identity, not timing. Whatever we attached to — fresh,
    // reattach or cold restore — an exit naming a different incarnation of the id is not ours, so
    // it is safe to drop even for the reattach the fence below deliberately leaves alone.
    discardPreHandlerPtyExitFromForeignIncarnation(spawnResult.id, spawnResult.incarnationId)
    if (!admittedSessionId && !spawnResult.isReattach && !spawnResult.coldRestore) {
      // Why only a fresh spawn: a reattach deliberately re-owns an id that already existed, so its
      // buffered exit is the real thing. A fresh spawn's PTY did not exist yet.
      discardPreHandlerPtyStateFromPriorIncarnation(spawnResult.id, priorIncarnationFence)
    }
    context.bind(spawnResult.id)
    if (!spawnResult.isReattach && !spawnResult.coldRestore) {
      onPtySpawn?.(spawnResult.id)
    }
    handlers.registerData(spawnResult.id)
    const exitedBeforeAttach = handlers.registerExit(spawnResult.id, spawnResult.incarnationId)
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
