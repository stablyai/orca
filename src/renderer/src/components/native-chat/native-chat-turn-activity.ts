import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import { pairNativeChatToolBlocks, type NativeChatToolStep } from './native-chat-message-grouping'

export type NativeChatActivityStatus = 'completed' | 'running' | 'failed' | 'incomplete'

export type NativeChatActivityStep = {
  step: NativeChatToolStep
  status: NativeChatActivityStatus
}

export type NativeChatTurnActivity = {
  status: NativeChatActivityStatus
  steps: NativeChatActivityStep[]
  summaryStep: NativeChatActivityStep
}

/** Scope global working state to tool activity after the latest user boundary.
 * A new prompt must not make a completed tool run from the prior turn spin again. */
export function activeNativeChatToolMessageId(
  messages: readonly NativeChatMessage[],
  isWorking: boolean
): string | null {
  if (!isWorking) {
    return null
  }
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  return (
    messages
      .slice(lastUserIndex + 1)
      .findLast((message) =>
        message.blocks.some((block) => isToolCallBlock(block) || isToolResultBlock(block))
      )?.id ?? null
  )
}

function settledStepStatus(step: NativeChatToolStep): NativeChatActivityStatus {
  if (step.result) {
    return step.result.outcome === 'error' || step.result.isError ? 'failed' : 'completed'
  }
  if (step.call?.status === 'completed') {
    return 'completed'
  }
  if (step.call?.status === 'in-progress') {
    return 'running'
  }
  return 'incomplete'
}

function newestWithStatus(
  steps: readonly NativeChatActivityStep[],
  status: NativeChatActivityStatus
): NativeChatActivityStep | null {
  return steps.findLast((step) => step.status === status) ?? null
}

/** Build the compact disclosure state from the same blocks the legacy tool run
 * rendered. Transcript details remain in the paired steps; this only chooses
 * which lifecycle state and operation should stay visible while collapsed. */
export function buildNativeChatTurnActivity(
  blocks: readonly NativeChatBlock[],
  isWorking: boolean
): NativeChatTurnActivity | null {
  const steps = pairNativeChatToolBlocks(blocks).map(
    (step): NativeChatActivityStep => ({ step, status: settledStepStatus(step) })
  )
  if (steps.length === 0) {
    return null
  }

  const unresolved = newestWithStatus(steps, 'incomplete')
  const visibleSteps = steps.map((item) =>
    isWorking && item === unresolved ? { ...item, status: 'running' as const } : item
  )
  const failed = newestWithStatus(visibleSteps, 'failed')
  const running = newestWithStatus(visibleSteps, 'running')
  const stillUnresolved = newestWithStatus(visibleSteps, 'incomplete')
  const latest = visibleSteps.at(-1)!

  // Why: a live provider may be thinking after its last completed operation,
  // so the run remains active even when every currently visible step settled.
  const status: NativeChatActivityStatus = failed
    ? 'failed'
    : isWorking || running
      ? 'running'
      : stillUnresolved
        ? 'incomplete'
        : 'completed'

  return {
    status,
    steps: visibleSteps,
    // Why: failures stay visible even while the provider continues working.
    summaryStep: failed ?? running ?? stillUnresolved ?? latest
  }
}
