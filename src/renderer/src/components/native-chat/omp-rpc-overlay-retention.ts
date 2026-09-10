// Retention budgets for the OMP RPC turn overlay's own state (F11).
//
// Every field the reducer accumulates across a turn — streamed prose, tool
// output, block lists, a drained history snapshot — is bounded here rather
// than at each use site, so the budgets are one readable list instead of
// constants scattered through the state machine.

import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OmpRpcAdvisorCard } from './omp-rpc-advisor-card'

/** Byte budget for a single retained tool-result output; a tool that returns
 *  a large file read or command log must not grow renderer state unbounded.
 *  Matches the head/tail-window precedent in
 *  omp-rpc-process-transport.ts's `STDERR_TAIL_BYTES`. */
export const TOOL_OUTPUT_MAX_BYTES = 65_536
/** Character budget for the retained overlay text (assistantText/
 *  reasoningText) — one turn's streamed prose is capped to a head/tail
 *  window rather than growing without bound. */
export const OVERLAY_TEXT_MAX_CHARS = 32_768
/** Max retained overlay blocks; oldest blocks are dropped once exceeded so a
 *  turn with hundreds of tool calls cannot grow the array unboundedly. */
const OVERLAY_MAX_BLOCKS = 500
/** Max retained hydrated history messages. The head is dropped rather than the
 *  tail, matching the transcript read's own most-recent-first window
 *  (native-chat-pagination.ts). */
export const OMP_RPC_HYDRATED_HISTORY_MAX_MESSAGES = 2000
const TRUNCATION_MARKER = '\n…[truncated]…\n'

/** Cap a string to a byte/char budget by keeping a head and tail window and
 *  marking the cut, rather than growing without bound. */
export function capOverlayText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  const half = Math.floor((maxLength - TRUNCATION_MARKER.length) / 2)
  return text.slice(0, half) + TRUNCATION_MARKER + text.slice(text.length - half)
}

/** Cap the retained block count, dropping the oldest once exceeded. */
export function capOverlayBlocks(blocks: NativeChatBlock[]): NativeChatBlock[] {
  return blocks.length > OVERLAY_MAX_BLOCKS
    ? blocks.slice(blocks.length - OVERLAY_MAX_BLOCKS)
    : blocks
}

/** Keep only the most recent hydrated history messages. */
export function capHydratedHistory(messages: NativeChatMessage[]): NativeChatMessage[] {
  return messages.length > OMP_RPC_HYDRATED_HISTORY_MAX_MESSAGES
    ? messages.slice(messages.length - OMP_RPC_HYDRATED_HISTORY_MAX_MESSAGES)
    : messages
}

/** Max retained advisor cards. They outlive their turn — only transcript
 *  coverage may retire one, and that evidence can lag arbitrarily — so the
 *  budget is what keeps a long advised session bounded. Oldest first out: the
 *  newest advice is the advice still worth showing. */
export const OMP_RPC_ADVISOR_CARDS_MAX = 50

/** Keep only the most recent advisor cards. */
export function capAdvisorCards(cards: OmpRpcAdvisorCard[]): OmpRpcAdvisorCard[] {
  return cards.length > OMP_RPC_ADVISOR_CARDS_MAX
    ? cards.slice(cards.length - OMP_RPC_ADVISOR_CARDS_MAX)
    : cards
}

/** Keep only the most recent retirements. Shares the card budget because the
 *  ledger only has to outlive the frames that could re-deliver a retired card
 *  (its own `message_start`/`message_end` pair), never the whole session. */
export function capAdvisorTurnIds(turnIds: string[]): string[] {
  return turnIds.length > OMP_RPC_ADVISOR_CARDS_MAX
    ? turnIds.slice(turnIds.length - OMP_RPC_ADVISOR_CARDS_MAX)
    : turnIds
}
