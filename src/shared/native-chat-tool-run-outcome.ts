// Derive success independently of live activity: no active call does not prove success, and collapsed headers must expose failures.

import { agentJournalToolCallLifecycle } from './agent-journal-tool-call-lifecycle'
import { selectActiveToolCall } from './native-chat-tool-activity'
import type { NativeChatBlock } from './native-chat-types'

export type NativeChatToolRunOutcome = {
  failedCallCount: number
  /** Calls a stop or the session's end cut short: neither a failure nor a success. */
  interruptedCallCount: number
  succeeded: boolean
}

/** Success requires settled calls without failure/interruption. Recheck running states even after selectActiveToolCall:
 * that selector hides activity once its turn ends, but calls cannot inherit completion. Legacy absent lifecycle still settles without explicit completed. */
export function nativeChatToolRunOutcome(
  blocks: readonly NativeChatBlock[],
  { activeTurnIsWorking }: { activeTurnIsWorking?: boolean }
): NativeChatToolRunOutcome {
  let failedStateCount = 0
  let interruptedCallCount = 0
  let errorResultCount = 0
  let hasRunningCall = false
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      const lifecycle = agentJournalToolCallLifecycle(block)
      failedStateCount += lifecycle === 'failed' ? 1 : 0
      interruptedCallCount += lifecycle === 'interrupted' ? 1 : 0
      hasRunningCall ||= lifecycle === 'running'
    } else if (block.type === 'tool-result') {
      errorResultCount += block.isError === true ? 1 : 0
    }
  }
  // Structured lanes carry both signals for one failure; legacy lanes carry only the result.
  const failedCallCount = Math.max(failedStateCount, errorResultCount)
  return {
    failedCallCount,
    interruptedCallCount,
    succeeded:
      selectActiveToolCall(blocks, { activeTurnIsWorking }) === null &&
      !hasRunningCall &&
      failedCallCount === 0 &&
      interruptedCallCount === 0
  }
}
