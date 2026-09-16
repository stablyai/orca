import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'

export type StructuredAgentLaunchOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
  /** Adopt an existing provider conversation instead of starting a fresh one. Part of the launch's
   *  identity, not a preference — see `launchIdentity`. */
  resumeFrom?: StructuredAgentSessionResumeSource
}

export type StructuredLaunchCaller = {
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

export type StructuredLaunchCallerGroup = {
  outcome: 'pending' | 'published' | 'failed' | 'unknown' | 'cancelled'
  entries: Set<StructuredLaunchCaller>
  promptDeliveryResults: Set<Promise<StructuredPromptDeliveryResult>>
  onSettled: () => void
}

export function createStructuredLaunchCallerGroup(): StructuredLaunchCallerGroup {
  return {
    outcome: 'pending',
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
  options: StructuredAgentLaunchOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): StructuredLaunchCaller {
  const caller: StructuredLaunchCaller = {}
  args.group.entries.add(caller)
  const promptDeliveryResult = settleStructuredAgentLaunchPrompt({
    launchResult: args.launchResult,
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
