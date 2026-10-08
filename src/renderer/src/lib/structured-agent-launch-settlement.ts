import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  cancelStructuredAgentLaunch,
  startStructuredAgentLaunch,
  type StructuredAgentLaunchOptions
} from '@/lib/structured-agent-session-launch'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import { findIdleEmptyStructuredChat } from '@/lib/structured-agent-session-idle-empty-chat'

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
  onStructuredReady?: (sessionId: string) => void
  /** Abort the moment the caller abandons the launch. The loop cancels on the event, not only by
   *  polling after awaits, so a staged prompt is discarded before it can reach the provider. */
  signal?: AbortSignal
}

export type StructuredAgentLaunchHandle = {
  sessionId: string
  /** The host the chat is created on. */
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
  // Why: the caller may have been abandoned between its own check and this subscription.
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
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      return { kind: 'failed', error }
    }
    if (launch.isVisibilityUnknown()) {
      // Why: the state stays pending for the unknown badge and retry, but this caller is done.
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
  // A new chat with nothing to say reuses an empty published one open here (the launch joins an
  // empty starting one); the reused chat is not this caller's to cancel.
  const idle =
    options.resumeFrom || options.prompt?.trim()
      ? undefined
      : findIdleEmptyStructuredChat(
          worktreeId,
          agent,
          options.executionHostId,
          options.targetGroupId
        )
  if (idle) {
    return {
      ...idle,
      settlement: Promise.resolve().then((): StructuredAgentLaunchSettlement => {
        if (hooks.signal?.aborted) {
          return { kind: 'cancelled', sessionId: idle.sessionId }
        }
        hooks.onStructuredReady?.(idle.sessionId)
        return { kind: 'structured', sessionId: idle.sessionId }
      }),
      cancel: () => {}
    }
  }
  const launch = startStructuredAgentLaunch(worktreeId, agent, options)
  return {
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
