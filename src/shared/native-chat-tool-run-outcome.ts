// A run of tool calls → the two facts its collapsed header may state: whether
// the run succeeded, and how many of its calls did not.
//
// Shared, and separate from the live-activity derivation, because success is a
// claim the header makes on its own. "Nothing is running" is not that claim:
// `failed` is neither running nor a success, so a header that reads one off the
// other marks a failed run done and leaves the failure to be found by expanding
// it. Success must be stated, which is what `nativeChatToolRunOutcome` does.

import { selectActiveToolCall } from './native-chat-tool-activity'
import type { NativeChatBlock } from './native-chat-types'

export type NativeChatToolRunOutcome = {
  failedCallCount: number
  succeeded: boolean
}

/** Whether the run may be marked done: settled, nothing failed, nothing still
 *  running. The running test is repeated after `selectActiveToolCall` on
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
  let errorResultCount = 0
  let hasRunningCall = false
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      failedStateCount += block.state === 'failed' ? 1 : 0
      hasRunningCall ||= block.state === 'running'
    } else if (block.type === 'tool-result') {
      errorResultCount += block.isError === true ? 1 : 0
    }
  }
  // Structured lanes carry both signals for one failure; legacy lanes carry only the result.
  const failedCallCount = Math.max(failedStateCount, errorResultCount)
  return {
    failedCallCount,
    succeeded:
      selectActiveToolCall(blocks, { activeTurnIsWorking }) === null &&
      !hasRunningCall &&
      failedCallCount === 0
  }
}
