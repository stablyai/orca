import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import { findNativeChatFinalMessageIndex } from '../../../../shared/native-chat-final-message'
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
      segments: NativeChatTurnSegment[]
      activityMessages: NativeChatMessage[]
      finalMessage: NativeChatMessage | null
      startedAt: number | null
      completedAt: number | null
      outcome: NativeChatTurnCompletion['outcome'] | null
      working: boolean
      turnId: string | null
    }

export type NativeChatTurnSegment =
  | { kind: 'activity'; id: string; messages: NativeChatMessage[] }
  | { kind: 'message'; id: string; message: NativeChatMessage }

export type NativeChatTurnCompletion = {
  outcome: 'completed' | 'interrupted' | 'failed'
  completedAt: number
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
  workingStartedAt: number | null = null,
  activeTurnId: string | null = null,
  turnCompletions?: Readonly<Record<string, NativeChatTurnCompletion>>
): NativeChatConversationItem[] {
  const items: NativeChatConversationItem[] = []
  let turn:
    | {
        id: string
        turnId: string | null
        startedAt: number | null
        messages: NativeChatMessage[]
      }
    | undefined

  const flush = (last = false): void => {
    if (!turn) {
      return
    }
    const isActive = working && (activeTurnId ? turn.turnId === activeTurnId : last)
    const completion = turn.turnId ? turnCompletions?.[turn.turnId] : undefined
    items.push(
      buildAssistantTurn(
        turn.messages,
        isActive ? (workingStartedAt ?? turn.startedAt) : turn.startedAt,
        isActive,
        `assistant-turn:${turn.id}`,
        turn.turnId,
        completion,
        turnCompletions === undefined
      )
    )
    turn = undefined
  }

  for (const message of messages) {
    if (message.role === 'user' || message.role === 'system') {
      if (message.role === 'user' && turn?.turnId && message.turnId === turn.turnId) {
        turn.messages.push(message)
        continue
      }
      flush()
      items.push({ kind: 'message', id: message.id, message })
      if (message.role === 'user') {
        turn = {
          id: message.id,
          turnId: message.turnId ?? null,
          startedAt: message.timestamp,
          messages: []
        }
      }
      continue
    }
    if (turn && (!message.turnId || !turn.turnId || message.turnId === turn.turnId)) {
      turn.messages.push(message)
      turn.turnId ??= message.turnId ?? null
      continue
    }
    flush()
    turn = {
      id: message.id,
      turnId: message.turnId ?? null,
      startedAt: message.timestamp,
      messages: [message]
    }
  }
  flush(true)

  if (working && !items.some((item) => item.kind === 'assistant-turn' && item.working)) {
    const current = items.at(-1)
    items.push(
      buildAssistantTurn(
        [],
        workingStartedAt ?? (current?.kind === 'message' ? current.message.timestamp : null),
        true,
        `assistant-turn:${current?.id ?? 'live'}`,
        activeTurnId,
        undefined,
        turnCompletions === undefined
      )
    )
  }
  return items
}

function buildAssistantTurn(
  messages: NativeChatMessage[],
  anchorTimestamp: number | null,
  working = false,
  id = `assistant-turn:${messages[0]?.id ?? 'empty'}`,
  turnId: string | null = null,
  completion?: NativeChatTurnCompletion,
  inferCompletion = true
): Extract<NativeChatConversationItem, { kind: 'assistant-turn' }> {
  const successful = completion?.outcome === 'completed' || (inferCompletion && !completion)
  const finalIndex = working || !successful ? -1 : findNativeChatFinalMessageIndex(messages, true)
  const finalMessage = finalIndex !== -1 ? messages[finalIndex]! : null
  const activityMessages = messages.filter(
    (message, index) => index !== finalIndex && message.role !== 'user' && message.role !== 'system'
  )
  const timestamps = messages.flatMap((message) =>
    message.timestamp == null ? [] : [message.timestamp]
  )
  return {
    kind: 'assistant-turn',
    id,
    segments: buildTurnSegments(messages, finalIndex),
    activityMessages,
    finalMessage,
    startedAt: anchorTimestamp ?? timestamps[0] ?? null,
    completedAt:
      !working && (completion?.outcome === 'completed' || (inferCompletion && !completion))
        ? (completion?.completedAt ??
          finalMessage?.timestamp ??
          timestamps.at(-1) ??
          anchorTimestamp)
        : null,
    outcome: working
      ? null
      : (completion?.outcome ?? (inferCompletion && !completion ? 'completed' : null)),
    working,
    turnId
  }
}

function buildTurnSegments(
  messages: NativeChatMessage[],
  finalIndex: number
): NativeChatTurnSegment[] {
  const segments: NativeChatTurnSegment[] = []
  let activity: NativeChatMessage[] = []
  const flushActivity = (): void => {
    if (activity.length) {
      segments.push({ kind: 'activity', id: `activity:${activity[0]!.id}`, messages: activity })
      activity = []
    }
  }
  messages.forEach((message, index) => {
    if (index === finalIndex) {
      return
    }
    if (message.role === 'user' || message.role === 'system') {
      flushActivity()
      segments.push({ kind: 'message', id: message.id, message })
    } else {
      activity.push(message)
    }
  })
  flushActivity()
  return segments
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
