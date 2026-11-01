import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  cancelStructuredAgentLaunch,
  startStructuredAgentLaunch,
  type StructuredAgentLaunchOptions
} from '@/lib/structured-agent-session-launch'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import { StructuredAgentSessionCreateAbandonedError } from './structured-agent-session-launch-errors'

export type StructuredAgentLaunchSettlement =
  | {
      kind: 'structured'
      sessionId: string
      promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
    }
  | {
      kind: 'cancelled'
      /** Null when the launch was abandoned before its host admitted a chat. */
      sessionId: string | null
    }
  | { kind: 'visibility-unknown'; sessionId: string }
  /** `notified`: the launch already told the user, so a caller adds no message of its own. */
  | { kind: 'failed'; error: unknown; notified?: true }
  /** The owning host declined the chat before anything was created; its terminal opened instead. */
  | { kind: 'terminal' }

export type StructuredAgentLaunchHooks = {
  activate?: boolean
  onStructuredReady?: (sessionId: string) => void
  // Abort on the caller’s event, not only after awaits, so abandoned staged prompts never reach providers.
  signal?: AbortSignal
  beforeCreate?: () => boolean
}

export type StructuredAgentLaunchHandle = {
  /** An existing launch retains publication and any draft it already owns. */
  joined?: boolean
  sessionId: string
  executionHostId: ExecutionHostId
  settlement: Promise<StructuredAgentLaunchSettlement>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  cancel: () => void
}

async function settleStartedStructuredAgentLaunch(
  worktreeId: string,
  launch: ReturnType<typeof startStructuredAgentLaunch>,
  hooks: StructuredAgentLaunchHooks
): Promise<StructuredAgentLaunchSettlement> {
  const signal = hooks.signal
  let cancelRequested = false
  const isCancelled = (): boolean => cancelRequested || signal?.aborted === true
  const cancelLaunch = (): void => {
    if (cancelRequested) {
      return
    }
    cancelRequested = true
    cancelStructuredAgentLaunch(worktreeId, launch.sessionId)
  }
  signal?.addEventListener('abort', cancelLaunch, { once: true })
  // The caller can retire between its initial check and this subscription.
  if (isCancelled()) {
    cancelLaunch()
  }
  const cancelled = (): StructuredAgentLaunchSettlement => ({
    kind: 'cancelled',
    sessionId: launch.sessionId
  })
  try {
    const receipt = await launch.launchResult
    if (isCancelled()) {
      return cancelled()
    }
    hooks.onStructuredReady?.(receipt.sessionId)
    return {
      kind: 'structured',
      sessionId: receipt.sessionId,
      ...(launch.promptDeliveryResult ? { promptDeliveryResult: launch.promptDeliveryResult } : {})
    }
  } catch (error) {
    if (isCancelled()) {
      return cancelled()
    }
    if (error instanceof StructuredAgentSessionCreateAbandonedError) {
      return cancelled()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      return { kind: 'failed', error }
    }
    if (launch.isVisibilityUnknown()) {
      // Unknown state retains badge/retry even though this caller is finished.
      launch.releaseCallerAfterUnknownOutcome()
      return { kind: 'visibility-unknown', sessionId: launch.sessionId }
    }
    return { kind: 'failed', error }
  } finally {
    signal?.removeEventListener('abort', cancelLaunch)
  }
}

/** Exposes the durable identity before host acquisition so its chat can render immediately. */
export function beginStructuredAgentLaunchSettlement(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions,
  hooks: StructuredAgentLaunchHooks
): StructuredAgentLaunchHandle {
  const launch = startStructuredAgentLaunch(worktreeId, agent, {
    ...options,
    ...(hooks.activate !== undefined ? { activate: hooks.activate } : {}),
    ...(hooks.beforeCreate ? { beforeCreate: hooks.beforeCreate } : {})
  })
  // Joining transfers no source ownership to the already independent destination.
  if (launch.joined) {
    hooks.beforeCreate?.()
  }
  return {
    joined: launch.joined,
    sessionId: launch.sessionId,
    executionHostId: launch.executionHostId,
    settlement: settleStartedStructuredAgentLaunch(worktreeId, launch, hooks),
    cancel: () => cancelStructuredAgentLaunch(worktreeId, launch.sessionId),
    ...(launch.promptDeliveryResult ? { promptDeliveryResult: launch.promptDeliveryResult } : {})
  }
}

/** Compatibility wrapper for callers that do not need the provisional identity. */
export function settleStructuredAgentLaunch(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions,
  hooks: StructuredAgentLaunchHooks
): Promise<StructuredAgentLaunchSettlement> {
  return beginStructuredAgentLaunchSettlement(worktreeId, agent, options, hooks).settlement
}
