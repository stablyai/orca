import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
import type { AgentLaunchProfile } from '../../../shared/agent-launch-profile'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { StructuredLaunchAttempt } from './structured-agent-session-launch-request'
import type { AgentLaunchRequestId } from './agent-launch-request-id'

export type StructuredAgentLaunchOptions = {
  agentProfile?: AgentLaunchProfile
  /** The user action this start serves; only a re-delivery of it joins its chat. */
  requestId: AgentLaunchRequestId
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
  /** Adopt an existing provider conversation instead of starting a fresh one. Part of the launch's
   *  identity, not a preference — see `launchIdentity`. */
  resumeFrom?: StructuredAgentSessionResumeSource
  /** The host the route decided on; read only by the caller that starts the launch. */
  executionHostId?: ExecutionHostId
  /** The saved selection a paired host reported it will seed; read only by the starting caller. */
  hostSeedOptions?: Readonly<Record<string, string>>
  /** The tab group the chat opens in; a request with no text reuses an empty chat only there. */
  targetGroupId?: string
}

export type StructuredLaunchCaller = {
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

export type StructuredLaunchCallerGroup = {
  outcome: 'pending' | 'published' | 'failed' | 'unknown' | 'cancelled'
  attempt: StructuredLaunchAttempt
  /** When this attempt failed; a retry starts a new group, so it never outlives the failure. */
  failedAt?: number
  entries: Set<StructuredLaunchCaller>
  promptDeliveryResults: Set<Promise<StructuredPromptDeliveryResult>>
  onSettled: () => void
}

export function createStructuredLaunchCallerGroup(
  attempt: StructuredLaunchAttempt
): StructuredLaunchCallerGroup {
  return {
    outcome: 'pending',
    attempt,
    entries: new Set(),
    promptDeliveryResults: new Set(),
    onSettled: () => {}
  }
}

function trackPromptDelivery(
  group: StructuredLaunchCallerGroup,
  promptDeliveryResult: Promise<StructuredPromptDeliveryResult>
): void {
  group.promptDeliveryResults.add(promptDeliveryResult)
  const settled = (): void => {
    group.promptDeliveryResults.delete(promptDeliveryResult)
    group.onSettled()
  }
  void promptDeliveryResult.then(settled, settled)
}

export function addStructuredLaunchCaller(args: {
  group: StructuredLaunchCallerGroup
  launchResult: Promise<{ sessionId: string; fence: number }>
  target: RuntimeClientTarget
  options: StructuredAgentLaunchOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): StructuredLaunchCaller {
  const caller: StructuredLaunchCaller = {}
  args.group.entries.add(caller)
  const promptDeliveryResult = settleStructuredAgentLaunchPrompt({
    launchResult: args.launchResult,
    target: args.target,
    options: args.options,
    stagedEntry: args.stagedEntry
  })
  caller.promptDeliveryResult = promptDeliveryResult?.catch(() => ({
    delivered: false,
    failureNotified: true
  }))
  if (caller.promptDeliveryResult) {
    trackPromptDelivery(args.group, caller.promptDeliveryResult)
  }
  return caller
}

export function settleStructuredLaunchCallers(
  group: StructuredLaunchCallerGroup,
  outcome: 'published' | 'failed' | 'cancelled'
): void {
  group.outcome = outcome
  if (outcome === 'failed') {
    group.failedAt = Date.now()
  }
  group.onSettled()
}

export function releaseStructuredLaunchCallerAfterUnknownOutcome(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller
): boolean {
  if (group.outcome !== 'unknown' || !group.entries.delete(caller)) {
    return false
  }
  group.onSettled()
  return true
}

export function structuredLaunchCallersHavePendingWork(
  group: StructuredLaunchCallerGroup
): boolean {
  return (
    group.outcome === 'pending' ||
    group.outcome === 'unknown' ||
    group.promptDeliveryResults.size > 0
  )
}
