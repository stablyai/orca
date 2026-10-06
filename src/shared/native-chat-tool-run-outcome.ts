// A run of tool calls → the facts its collapsed header may state: whether the
// run succeeded, how many of its calls failed, and how many were cut short.
//
// Shared, and separate from the live-activity derivation, because success is a
// claim the header makes on its own. "Nothing is running" is not that claim:
// `failed` is neither running nor a success, so a header that reads one off the
// other marks a failed run done and leaves the failure to be found by expanding
// it. Success must be stated, which is what `nativeChatToolRunOutcome` does.

import { agentJournalToolCallLifecycle } from './agent-journal-tool-call-lifecycle'
import { selectActiveToolCall } from './native-chat-tool-activity'
import type { NativeChatBlock } from './native-chat-types'

export type NativeChatToolRunOutcome = {
  failedCallCount: number
  /** Calls a stop or the session's end cut short: neither a failure nor a success. */
  interruptedCallCount: number
  succeeded: boolean
}

/** Whether the run may be marked done: settled, nothing failed or cut short,
 *  nothing still running. The running test is repeated after `selectActiveToolCall` on
 *  purpose — that one reports no active call once the turn is known to be over,
 *  and an item still running cannot inherit completion from its turn.
 *
 *  A call carrying no lifecycle `state` is not a failure and not in flight, so a
 *  legacy transcript still settles; nothing here demands an explicit `completed`
 *  that those lanes never wrote. */
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
