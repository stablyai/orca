// Which result belongs to which call inside one run.
//
// A run's blocks arrive as a flat stream of calls and results, and the renderer
// used to draw both: every call line was followed by a `Result` line of its own.
// That doubles the height of an opened run and puts the least interesting row —
// a result whose preview is usually the first line of stdout — at the same level
// as the command that produced it. Pairing lets the call own its output, so the
// run reads as the work it did.
//
// A result that names its call answers that call. One that does not is paired
// positionally, the same FIFO rule `dropUnattributableToolResults` already uses to
// decide a result is attributable at all: it answers the oldest call that has not
// been answered yet. Position alone misattributes every later result once one call
// finishes with no output, which is why a producer that knows the call names it.

import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from './native-chat-types'

export type NativeChatToolPairing = {
  /** The result each call owns. A call still running has none. */
  resultByCall: ReadonlyMap<NativeChatToolCallBlock, NativeChatToolResultBlock>
  /** Results a call now owns, so the run does not also draw them as rows. */
  pairedResults: ReadonlySet<NativeChatBlock>
}

export const NO_NATIVE_CHAT_TOOL_PAIRING: NativeChatToolPairing = {
  resultByCall: new Map(),
  pairedResults: new Set()
}

export function pairNativeChatToolResults(
  blocks: readonly NativeChatBlock[]
): NativeChatToolPairing {
  const resultByCall = new Map<NativeChatToolCallBlock, NativeChatToolResultBlock>()
  const pairedResults = new Set<NativeChatBlock>()
  const unanswered: NativeChatToolCallBlock[] = []
  for (const block of blocks) {
    if (isToolCallBlock(block)) {
      unanswered.push(block)
      continue
    }
    if (!isToolResultBlock(block)) {
      continue
    }
    const named =
      block.callId === undefined ? -1 : unanswered.findIndex((call) => call.callId === block.callId)
    const [call] = unanswered.splice(named === -1 ? 0 : named, 1)
    if (call === undefined) {
      continue
    }
    resultByCall.set(call, block)
    pairedResults.add(block)
  }
  return { resultByCall, pairedResults }
}
