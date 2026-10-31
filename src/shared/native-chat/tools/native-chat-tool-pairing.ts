// Pair named results only with their waiting call; missing named calls stay unpaired. Unnamed results use oldest-unanswered FIFO,
// matching dropUnattributableToolResults. Producers must name calls when possible: outputless calls shift positional matches.
// Call-owned output avoids duplicate Result rows in expanded runs.

import { pairToolBlocks } from './native-chat-tool-pairs'
import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../native-chat-types'

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
