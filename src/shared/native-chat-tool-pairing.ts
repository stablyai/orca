// Which result belongs to which call inside one run.
//
// A run's blocks arrive as a flat stream of calls and results, and the renderer
// used to draw both: every call line was followed by a `Result` line of its own.
// That doubles the height of an opened run and puts the least interesting row —
// a result whose preview is usually the first line of stdout — at the same level
// as the command that produced it. Pairing lets the call own its output, so the
// run reads as the work it did.
//
// A result that names its call answers that call, and no other: one naming a call
// that is not waiting (outside a bounded window, say) stays unpaired. One that names
// none is paired positionally, the same FIFO rule `dropUnattributableToolResults`
// already uses to decide a result is attributable at all: it answers the oldest call
// that has not been answered yet. Position alone misattributes every later result once
// one call finishes with no output, which is why a producer that knows the call names it.

import { pairToolBlocks } from './native-chat-tool-fold'
import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from './native-chat-types'

export type NativeChatToolPairing = {
  /** The result each call owns. A call still running has none. */
  resultByCall: ReadonlyMap<NativeChatToolCallBlock, NativeChatToolResultBlock>
  /** Results a call now owns, so the run does not also draw them as rows. */
  pairedResults: ReadonlySet<NativeChatBlock>
}

/** The desktop run's view of `pairToolBlocks`, so every reader of a run pairs with one loop. */
export function pairNativeChatToolResults(
  blocks: readonly NativeChatBlock[]
): NativeChatToolPairing {
  const resultByCall = new Map<NativeChatToolCallBlock, NativeChatToolResultBlock>()
  const pairedResults = new Set<NativeChatBlock>()
  for (const { call, result } of pairToolBlocks(blocks)) {
    if (call && result) {
      resultByCall.set(call, result)
      pairedResults.add(result)
    }
  }
  return { resultByCall, pairedResults }
}
