// Pure grouping logic for the native chat message list. Kept out of the .tsx so
// the pairing/ordering rules are unit-testable without rendering. Two jobs:
//   1. Order messages stably (timestamp then id; null timestamps sort first as
//      the shared model documents) — the assembler already sorts, but the list
//      re-sorts defensively so a caller passing unordered fixtures still reads
//      correctly.
//   2. Within an assistant turn, pair each tool-call block with the tool-result
//      that answers it so the view can render one collapsible step instead of
//      two disconnected rows.

import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import { compareMessages } from './native-chat-session-assembler'

/** A tool-call block paired with the result that answered it, when one exists.
 *  `result` is null while the call is still in flight (no result yet). */
export type NativeChatToolStep = {
  call: NativeChatToolCallBlock
  result: NativeChatToolResultBlock | null
}

/** One renderable item in the list: either a prose/role message carrying its
 *  non-tool blocks, or a tool step (call + optional result). The view renders
 *  each variant differently. */
export type NativeChatRenderItem =
  | {
      kind: 'message'
      id: string
      message: NativeChatMessage
      /** The message's blocks minus tool-call/tool-result (those become steps). */
      blocks: NativeChatBlock[]
    }
  | {
      kind: 'tool-step'
      id: string
      /** Role of the message the call originated from (assistant/tool). */
      role: NativeChatMessage['role']
      timestamp: number | null
      step: NativeChatToolStep
    }

/** Order messages stably: null timestamps first (model rule), then ascending
 *  timestamp, ties broken by id. Shares the assembler's comparator so both
 *  paths order identically. */
export function orderNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  return [...messages].sort(compareMessages)
}

/** Collect every tool-result across the whole conversation in document order so
 *  a call can find its answer even when the result lands in a later message (the
 *  common transcript shape: assistant emits the call, a following tool message
 *  carries the result). Results carry no originating name in our model, so they
 *  are handed out FIFO to calls. */
function collectToolResults(messages: NativeChatMessage[]): NativeChatToolResultBlock[] {
  const results: NativeChatToolResultBlock[] = []
  for (const message of messages) {
    for (const block of message.blocks) {
      if (isToolResultBlock(block)) {
        results.push(block)
      }
    }
  }
  return results
}

/**
 * Flatten ordered messages into render items, pairing tool calls with results.
 * Result pairing is FIFO across the conversation: tool results in our model
 * carry no back-reference to a call id, so we match the Nth call to the Nth
 * result in document order — the order both providers emit them. A call with no
 * remaining result renders as in-flight (`result: null`).
 */
export function buildNativeChatRenderItems(messages: NativeChatMessage[]): NativeChatRenderItem[] {
  const ordered = orderNativeChatMessages(messages)
  const resultQueue = collectToolResults(ordered)
  let resultCursor = 0

  const items: NativeChatRenderItem[] = []
  for (const message of ordered) {
    const nonToolBlocks: NativeChatBlock[] = []
    const steps: NativeChatToolStep[] = []

    for (const block of message.blocks) {
      if (isToolCallBlock(block)) {
        const result = resultQueue[resultCursor] ?? null
        if (result) {
          resultCursor += 1
        }
        steps.push({ call: block, result })
      } else if (isToolResultBlock(block)) {
        // Results are emitted as steps from the call side; skip standalone ones.
        continue
      } else {
        nonToolBlocks.push(block)
      }
    }

    if (nonToolBlocks.length > 0) {
      items.push({ kind: 'message', id: message.id, message, blocks: nonToolBlocks })
    }
    for (const [index, step] of steps.entries()) {
      items.push({
        kind: 'tool-step',
        id: `${message.id}:tool:${index}`,
        role: message.role,
        timestamp: message.timestamp,
        step
      })
    }
  }
  return items
}
