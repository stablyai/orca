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
  isTextBlock,
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
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

export type NativeChatConversationItem =
  | { kind: 'message'; id: string; message: NativeChatMessage }
  | {
      kind: 'assistant-turn'
      id: string
      activityMessages: NativeChatMessage[]
      finalMessage: NativeChatMessage | null
      startedAt: number | null
      completedAt: number | null
      working: boolean
    }

/** Order messages stably: null timestamps first (model rule), then ascending
 *  timestamp, ties broken by id. Shares the assembler's comparator so both
 *  paths order identically. */
export function orderNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  return [...messages].sort(compareMessages)
}

/** Group the transcript into user/system rows and assistant turns. Within a
 * turn the last completed assistant prose is the final answer; preceding
 * reasoning and tool records remain in their original activity chronology. */
export function buildNativeChatConversationItems(
  messages: NativeChatMessage[],
  working: boolean,
  workingStartedAt: number | null = null
): NativeChatConversationItem[] {
  const items: NativeChatConversationItem[] = []
  let pending: NativeChatMessage[] = []
  let anchorTimestamp: number | null = null
  let anchorId: string | null = null

  const flush = (): void => {
    if (pending.length === 0) {
      return
    }
    items.push(
      buildAssistantTurn(
        pending,
        anchorTimestamp,
        false,
        `assistant-turn:${anchorId ?? pending[0]?.id ?? 'empty'}`
      )
    )
    pending = []
  }

  for (const message of orderNativeChatMessages(messages)) {
    if (message.role === 'user' || message.role === 'system') {
      flush()
      items.push({ kind: 'message', id: message.id, message })
      anchorTimestamp = message.role === 'user' ? message.timestamp : null
      anchorId = message.role === 'user' ? message.id : null
    } else {
      pending.push(message)
    }
  }
  flush()

  if (working) {
    const current = items.at(-1)
    if (current?.kind === 'assistant-turn') {
      items[items.length - 1] = buildAssistantTurn(
        [...current.activityMessages, ...(current.finalMessage ? [current.finalMessage] : [])],
        workingStartedAt ?? current.startedAt,
        true,
        current.id
      )
    } else {
      items.push(
        buildAssistantTurn(
          [],
          workingStartedAt ?? current?.message.timestamp ?? null,
          true,
          `assistant-turn:${current?.id ?? 'live'}`
        )
      )
    }
  }
  return items
}

function buildAssistantTurn(
  messages: NativeChatMessage[],
  anchorTimestamp: number | null,
  working = false,
  id = `assistant-turn:${messages[0]?.id ?? 'empty'}`
): Extract<NativeChatConversationItem, { kind: 'assistant-turn' }> {
  const hasExplicitPhase = messages.some(
    (message) => message.role === 'assistant' && message.assistantPhase !== undefined
  )
  const finalIndex = messages.findLastIndex((message) =>
    hasExplicitPhase ? message.assistantPhase === 'final' : isFinalCandidate(message, working)
  )
  const finalMessage = finalIndex !== -1 ? messages[finalIndex]! : null
  const activityMessages = messages.filter((_, index) => index !== finalIndex)
  const timestamps = messages.flatMap((message) =>
    message.timestamp == null ? [] : [message.timestamp]
  )
  return {
    kind: 'assistant-turn',
    id,
    activityMessages,
    finalMessage,
    startedAt: anchorTimestamp ?? timestamps[0] ?? null,
    completedAt:
      working && finalMessage?.assistantPhase !== 'final'
        ? null
        : (finalMessage?.timestamp ?? timestamps.at(-1) ?? anchorTimestamp),
    working
  }
}

function isFinalCandidate(message: NativeChatMessage, working: boolean): boolean {
  if (message.role !== 'assistant') {
    return false
  }
  if (working && message.id !== NATIVE_CHAT_STREAMING_ID && message.source !== 'stream') {
    return false
  }
  return (
    message.blocks.some((block) => isTextBlock(block) || block.type === 'image-ref') &&
    !message.blocks.some(isToolCallBlock)
  )
}

/** Collect results across messages; provider IDs match exact calls and legacy results stay FIFO. */
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

/** Flatten messages into render items, pairing exact provider IDs before legacy FIFO results. */
export function buildNativeChatRenderItems(messages: NativeChatMessage[]): NativeChatRenderItem[] {
  const ordered = orderNativeChatMessages(messages)
  const resultQueue = collectToolResults(ordered)
  const resultsById = new Map(
    resultQueue.flatMap((result) =>
      result.toolCallId ? [[result.toolCallId, result] as const] : []
    )
  )
  let resultCursor = 0

  const items: NativeChatRenderItem[] = []
  for (const message of ordered) {
    const nonToolBlocks: NativeChatBlock[] = []
    const steps: NativeChatToolStep[] = []

    for (const block of message.blocks) {
      if (isToolCallBlock(block)) {
        let result = block.toolCallId ? (resultsById.get(block.toolCallId) ?? null) : null
        if (!block.toolCallId) {
          while (resultQueue[resultCursor]?.toolCallId) {
            resultCursor += 1
          }
          result = resultQueue[resultCursor] ?? null
          if (result) {
            resultCursor += 1
          }
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
