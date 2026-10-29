import { terminalLaunchFacts } from '../../../../shared/agent-session-resume'
import { readTerminalSpawnDeferral } from '../../../../shared/host-spawn-admission'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import { readIpcErrorDetail } from '@/lib/ipc-error'
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
import { settleAgentLaunchPaneStart } from '@/lib/agent-launch-pane-start'
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
  handleExplicitlyClosedConnect?: (id: string) => boolean
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
  const { onPtySpawn, retainDisposedSpawn } = transportOptions
  context.setCallbacks(options.callbacks)
  ensurePtyDispatcher()

  if (context.isDestroyed()) {
    return
  }
  if (options.sessionId && hasPreHandlerPtyExit(options.sessionId)) {
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
    // Fence before spawning: redeployed relays recycle IDs, so earlier buffered state belongs to a previous PTY lifetime.
    const priorIncarnationFence = currentPreHandlerPtySequence()
    const spawnResult = await spawnIpcPty(transportOptions, options, admittedSessionId)
    settleAgentLaunchPaneStart(transportOptions.tabId, transportOptions.leafId, spawnResult.id)
    const retireDisposedFreshSpawn = async (): Promise<void> => {
      if (context.handleExplicitlyClosedConnect?.(spawnResult.id)) {
        return
      }
      // A newer generation may already own a recycled id; an id-only kill would retire its PTY.
      if (spawnResult.isReattach || spawnResult.coldRestore || context.ownsPtyId(spawnResult.id)) {
        return
      }
      // A disposed transport can have a successor that still owns this PTY (#11003).
      if (retainDisposedSpawn?.() !== true) {
        await window.api.pty.kill(spawnResult.id)
      }
    }

    if (context.isDestroyed()) {
      await retireDisposedFreshSpawn()
      return
    }
    if (spawnResult.isReattach && !admittedSessionId) {
      context.getCallbacks().onReattachDetermined?.()
      if (context.isDestroyed()) {
        await retireDisposedFreshSpawn()
        return
      }
    }

    // Drop foreign-incarnation exits for fresh and restored sessions alike; identity proves they cannot belong to this attachment.
    discardPreHandlerPtyExitFromForeignIncarnation(spawnResult.id, spawnResult.incarnationId)
    if (!admittedSessionId && !spawnResult.isReattach && !spawnResult.coldRestore) {
      // Only fresh spawns discard pre-request state; reattach deliberately re-owns a pre-existing ID and needs its real buffered exit.
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
      return {
        ...terminalLaunchFacts(spawnResult),
        id: spawnResult.id,
        exitedBeforeAttach: true,
        // Why kept: a shell that replaced a resume and then exited never resumed the agent, and a
        // refused plan must still not be registered or consume the saved session.
        ...(spawnResult.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {}),
        ...(spawnResult.agentResumeRefused
          ? { agentResumeRefused: spawnResult.agentResumeRefused }
          : {})
      }
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
    settleAgentLaunchPaneStart(transportOptions.tabId, transportOptions.leafId, null)
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
  // Unclamped: host diagnoses put the remedy on later lines, and the pane toast renders them all.
  const message =
    readIpcErrorDetail(error) ?? (error instanceof Error ? error.message : String(error))
  if (connectionId && options.sessionId && isSshSessionGoneError(message)) {
    return { id: options.sessionId, sessionExpired: true }
  }
  if (message.includes('was explicitly killed')) {
    return undefined
  }
  const deferral = readTerminalSpawnDeferral(message)
  if (deferral) {
    context.getCallbacks().onSpawnDeferred?.(deferral)
    return undefined
  }
  if (connectionId && options.sessionId && message.includes(SSH_PTY_CONNECTION_MISMATCH_MARKER)) {
    // An unaddressable cross-connection ID is unverifiable, not expired; reattach recovery avoids cold-resuming a second agent onto a live transcript (docs/reference/ssh-execution-boundary.md).
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
