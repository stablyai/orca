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

/** One tool lifecycle row. Calls retain an optional result; a result-only row
 *  preserves output that cannot be correlated to a call. */
export type NativeChatToolStep =
  | {
      operationKey: string
      call: NativeChatToolCallBlock
      result: NativeChatToolResultBlock | null
    }
  | {
      operationKey: string
      call: null
      result: NativeChatToolResultBlock
    }

/** One renderable item in the list: either a prose/role message carrying its
 *  non-tool blocks, or a tool lifecycle step. The view renders each variant
 *  differently. */
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
      /** Role of the source message (assistant/tool). */
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

type IndexedToolCall = {
  block: NativeChatToolCallBlock
  blockIndex: number
  callId: string | null
  operationKey: string
}

type IndexedToolResult = {
  block: NativeChatToolResultBlock
  blockIndex: number
  callId: string | null
  operationKey: string
}

function usableCallId(callId: string | undefined): string | null {
  const normalized = callId?.trim()
  return normalized ? normalized : null
}

function indexedOperationKey(
  callId: string | null,
  duplicateOrdinal: number,
  blockIndex: number
): string {
  return callId
    ? `provider:${encodeURIComponent(callId)}:${duplicateOrdinal}`
    : `position:${blockIndex}`
}

function nextDuplicateOrdinal(callId: string | null, counts: Map<string, number>): number {
  if (!callId) {
    return 0
  }
  const ordinal = counts.get(callId) ?? 0
  counts.set(callId, ordinal + 1)
  return ordinal
}

function pairedOperationKey(call: IndexedToolCall, result: IndexedToolResult): string {
  // Why: append-only transcript updates must not remount an existing row when
  // its counterpart arrives; the earlier block owns identity for FIFO pairs.
  return call.blockIndex <= result.blockIndex ? call.operationKey : result.operationKey
}

/** Pair one ordered run of tool blocks. Exact provider ids are reserved first,
 *  then FIFO is retained only where at least one side lacks an id. */
export function pairNativeChatToolBlocks(blocks: readonly NativeChatBlock[]): NativeChatToolStep[] {
  const calls: IndexedToolCall[] = []
  const results: IndexedToolResult[] = []
  const callCountsById = new Map<string, number>()
  const resultCountsById = new Map<string, number>()
  for (const [blockIndex, block] of blocks.entries()) {
    if (isToolCallBlock(block)) {
      const callId = usableCallId(block.callId)
      const duplicateOrdinal = nextDuplicateOrdinal(callId, callCountsById)
      calls.push({
        block,
        blockIndex,
        callId,
        operationKey: indexedOperationKey(callId, duplicateOrdinal, blockIndex)
      })
    } else if (isToolResultBlock(block)) {
      const callId = usableCallId(block.callId)
      const duplicateOrdinal = nextDuplicateOrdinal(callId, resultCountsById)
      results.push({
        block,
        blockIndex,
        callId,
        operationKey: indexedOperationKey(callId, duplicateOrdinal, blockIndex)
      })
    }
  }

  const resultOrdinalsByCallId = new Map<string, number[]>()
  for (const [resultOrdinal, result] of results.entries()) {
    if (!result.callId) {
      continue
    }
    const ordinals = resultOrdinalsByCallId.get(result.callId) ?? []
    ordinals.push(resultOrdinal)
    resultOrdinalsByCallId.set(result.callId, ordinals)
  }

  const resultCursorByCallId = new Map<string, number>()
  const resultByCallBlockIndex = new Map<number, IndexedToolResult>()
  const consumedResults = results.map(() => false)
  for (const call of calls) {
    if (!call.callId) {
      continue
    }
    const ordinals = resultOrdinalsByCallId.get(call.callId)
    const cursor = resultCursorByCallId.get(call.callId) ?? 0
    const resultOrdinal = ordinals?.[cursor]
    if (resultOrdinal === undefined) {
      continue
    }
    resultCursorByCallId.set(call.callId, cursor + 1)
    resultByCallBlockIndex.set(call.blockIndex, results[resultOrdinal])
    consumedResults[resultOrdinal] = true
  }

  let anyResultCursor = 0
  let unlabeledResultCursor = 0
  for (const call of calls) {
    if (resultByCallBlockIndex.has(call.blockIndex)) {
      continue
    }
    let resultOrdinal: number | undefined
    if (call.callId) {
      while (
        unlabeledResultCursor < results.length &&
        (consumedResults[unlabeledResultCursor] || results[unlabeledResultCursor].callId)
      ) {
        unlabeledResultCursor += 1
      }
      if (unlabeledResultCursor < results.length) {
        resultOrdinal = unlabeledResultCursor
        unlabeledResultCursor += 1
      }
    } else {
      while (anyResultCursor < results.length && consumedResults[anyResultCursor]) {
        anyResultCursor += 1
      }
      if (anyResultCursor < results.length) {
        resultOrdinal = anyResultCursor
        anyResultCursor += 1
      }
    }
    if (resultOrdinal === undefined) {
      continue
    }
    resultByCallBlockIndex.set(call.blockIndex, results[resultOrdinal])
    consumedResults[resultOrdinal] = true
  }

  const resultOrdinalByBlockIndex = new Map(
    results.map((result, resultOrdinal) => [result.blockIndex, resultOrdinal])
  )
  const callByBlockIndex = new Map(calls.map((call) => [call.blockIndex, call]))
  const steps: NativeChatToolStep[] = []
  for (const [blockIndex, block] of blocks.entries()) {
    if (isToolCallBlock(block)) {
      const call = callByBlockIndex.get(blockIndex)!
      const result = resultByCallBlockIndex.get(blockIndex) ?? null
      steps.push({
        operationKey: result ? pairedOperationKey(call, result) : call.operationKey,
        call: block,
        result: result?.block ?? null
      })
    } else if (isToolResultBlock(block)) {
      const resultOrdinal = resultOrdinalByBlockIndex.get(blockIndex)
      if (resultOrdinal !== undefined && !consumedResults[resultOrdinal]) {
        steps.push({
          operationKey: results[resultOrdinal].operationKey,
          call: null,
          result: block
        })
      }
    }
  }
  return steps
}

/**
 * Flatten ordered messages into render items, pairing tool calls with results.
 * Provider ids pair first even when results arrive out of order. FIFO applies
 * only when a call or result has no usable id. Calls without a result remain in
 * flight, and unmatched results remain visible as result-only steps.
 */
export function buildNativeChatRenderItems(messages: NativeChatMessage[]): NativeChatRenderItem[] {
  const ordered = orderNativeChatMessages(messages)
  const toolSteps = pairNativeChatToolBlocks(ordered.flatMap((message) => message.blocks))
  const stepByCall = new Map(
    toolSteps.flatMap((step) => (step.call ? [[step.call, step] as const] : []))
  )
  const orphanStepByResult = new Map(
    toolSteps.flatMap((step) => (step.call ? [] : [[step.result, step] as const]))
  )

  const items: NativeChatRenderItem[] = []
  for (const message of ordered) {
    const nonToolBlocks: NativeChatBlock[] = []
    const steps: NativeChatToolStep[] = []

    for (const block of message.blocks) {
      if (isToolCallBlock(block)) {
        steps.push(stepByCall.get(block)!)
      } else if (isToolResultBlock(block)) {
        const step = orphanStepByResult.get(block)
        if (step) {
          steps.push(step)
        }
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
