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
import { isSshSessionGoneError } from './pty-connection/pty-connect-limits'
import { spawnIpcPty } from './ipc-pty-spawn-request'
import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'

const SSH_PTY_CONNECTION_MISMATCH_MARKER = 'belongs to SSH connection'

type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]

type IpcPtyConnectContext = {
  transportOptions: IpcPtyTransportOptions
  handlers: IpcPtySessionHandlers
  isDestroyed: () => boolean
  /** True only for the one buffered exit consumed by this connect attempt. */
  isExpectedExitCurrent: () => boolean
  ownsPtyId: (id: string) => boolean
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
      return context.isDestroyed() ? undefined : { id: options.sessionId }
    }
    if (context.isDestroyed()) {
      return
    }
    context.bind(options.sessionId)
    handlers.registerData(options.sessionId)
    if (context.isDestroyed()) {
      return
    }
    handlers.registerExit(options.sessionId)
    if (!context.isExpectedExitCurrent()) {
      return
    }
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
      // A newer generation may already own a recycled id; an id-only kill would retire its PTY.
      if (
        !spawnResult.isReattach &&
        !spawnResult.coldRestore &&
        !context.ownsPtyId(spawnResult.id)
      ) {
        await window.api.pty.kill(spawnResult.id)
      }
    }

    if (context.isDestroyed()) {
      await retireFreshSpawn()
      return
    }
    if (options.admitPtyId && !options.admitPtyId(spawnResult.id)) {
      await retireFreshSpawn()
      return context.isDestroyed() ? undefined : spawnResult
    }
    if (context.isDestroyed()) {
      await retireFreshSpawn()
      return
    }
    if (spawnResult.isReattach && !admittedSessionId) {
      context.getCallbacks().onReattachDetermined?.()
      if (context.isDestroyed()) {
        await retireFreshSpawn()
        return
      }
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
      if (context.isDestroyed()) {
        return
      }
    }
    handlers.registerData(spawnResult.id)
    if (context.isDestroyed()) {
      return
    }
    const exitedBeforeAttach = handlers.registerExit(spawnResult.id, spawnResult.incarnationId)
    if (exitedBeforeAttach) {
      if (!context.isExpectedExitCurrent()) {
        return
      }
      return { id: spawnResult.id, exitedBeforeAttach: true }
    }
    if (context.isDestroyed()) {
      return
    }
    if (!context.isCurrent(spawnResult.id)) {
      return
    }

    context.getCallbacks().onConnect?.()
    if (context.isDestroyed() || !context.isCurrent(spawnResult.id)) {
      return
    }
    context.getCallbacks().onStatus?.('shell')
    if (context.isDestroyed() || !context.isCurrent(spawnResult.id)) {
      return
    }
    return projectIpcPtyConnectResult(spawnResult)
  } catch (error) {
    if (context.isDestroyed()) {
      return
    }
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
  if (connectionId && options.sessionId && isSshSessionGoneError(message)) {
    return { id: options.sessionId, sessionExpired: true }
  }
  if (message.includes('was explicitly killed')) {
    return undefined
  }
  if (connectionId && options.sessionId && message.includes(SSH_PTY_CONNECTION_MISMATCH_MARKER)) {
    // Why not `sessionExpired`: this string is minted by `toRelaySshPtyId`/`toAppSshPtyId` from a
    // pure client-side id comparison, before any relay is contacted — it reports that the id is not
    // addressable through THIS connection, never that its process died. Respawning here cold-restores
    // the agent, and after an SSH target re-adoption the "other" connection is the same machine, so
    // that puts a second `claude --resume` on the transcript the surviving PTY still owns
    // (docs/reference/ssh-execution-boundary.md — an unaddressable id is `unverifiable`, not `exited`).
    // Returning undefined without an error keeps #7661's no-red-toast outcome while routing the pane
    // to the remount-and-reattach recovery instead of a fresh shell.
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
