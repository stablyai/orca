import { withNativeChatCutTurnNotices } from '../../../native-chat/transcript/turns/native-chat-cut-turn-notice'
import { createStructuredQuestionProjection } from '../../../native-chat/transcript/messages/structured-agent-question-projection'
import { createStructuredAgentSessionMessageProjection } from '../structured-agent-session-message-stream'
import { streamedAgentSessionTranscriptRows } from '../structured-agent-session-streamed-text-rows'
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../journal/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'

function item(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] }
  }
}

function hydrationPage(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[] = []
): AgentSessionHistoryPage {
  const oldest = items[0]?.sequence ?? 0
  const newest = items.at(-1)?.sequence ?? 0
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions,
    window: {
      oldest: items[0] ? { epoch: 'epoch-a', sequence: oldest } : null,
      newest: items.at(-1) ? { epoch: 'epoch-a', sequence: newest } : null,
      nextCursor: { epoch: 'epoch-a', sequence: oldest }
    },
    liveCursor: { epoch: 'epoch-a', sequence: newest },
    hasOlder: false,
    hasNewer: false
  }
}

describe('structured agent session reducer', () => {
  it("orders one journal write's items by their place in it, whatever order they arrive in", () => {
    const at = (id: string, sequence: number, sequenceIndex: number): AgentJournalRenderItem => ({
      ...item(id, sequence),
      ...(sequenceIndex > 0 ? { sequenceIndex } : {})
    })
    const paged = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: hydrationPage([
        item('before', 4),
        at('third', 5, 2),
        at('first', 5, 0),
        at('second', 5, 1)
      ])
    })
    expect(paged.items.map(({ itemId }) => itemId)).toEqual(['before', 'first', 'second', 'third'])
    const live = reduceStructuredAgentSession(paged, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 6 },
          items: [at('next-b', 6, 1), at('next-a', 6, 0)],
          removedItemIds: [],
          submissions: []
        }
      }
    })
    expect(live.items.map(({ itemId }) => itemId).slice(-2)).toEqual(['next-a', 'next-b'])
  })
})

// Count interpreted history rows, not array-reference copies needed by immutable consumers.
it('projects only changed streamed rows after IPC, including frames a consumer skipped', () => {
  for (const size of [128, 1280]) {
    let reads = 0
    const rows = Array.from({ length: size }, (_, index) => {
      const row = item(`row-${index}`, index + 1)
      const body = row.body
      Object.defineProperty(row, 'body', {
        enumerable: true,
        get: () => {
          reads++
          return body
        }
      })
      return row
    })
    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: {
        ...hydrationPage(rows, [
          {
            clientMessageId: 'withdrawn',
            fence: 1,
            payloadFingerprint: 'withdrawn',
            submittedAt: 0,
            submittedSequence: 0,
            dispatchState: 'rejected',
            reason: 'provider_cancelled_before_start',
            resolvedAt: 1,
            providerItemId: null
          }
        ]),
        hasOlder: true,
        latestTurn: {
          itemId: 'turn',
          observedAt: 1,
          turn: { turnId: 'turn', state: 'running', startedAt: 1 }
        },
        actionablePromptIds: ['ask'],
        working: true
      }
    })
    const turn = state.latestTurn
    const prompts = state.actionablePromptIds
    const questions = createStructuredQuestionProjection()
    const project = createStructuredAgentSessionMessageProjection(questions.messages)
    const receipts = questions.stream()
    const optimistic: [] = []
    const transcript = () =>
      withNativeChatCutTurnNotices(streamedAgentSessionTranscriptRows(state.items, 2))
    const first = transcript()
    const messages = project(first, optimistic, state.submissions)
    const initialReceipts = receipts(first).receipts
    reads = 0
    for (const [index, text] of [
      [size - 1, 'tail 1'],
      [size - 2, 'other'],
      [size - 1, 'tail 2']
    ] as const) {
      const changed = {
        ...item(`row-${index}`, index + 1),
        body: {
          kind: 'message' as const,
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, text }]
        }
      }
      state = reduceStructuredAgentSession(state, {
        type: 'event',
        event: structuredClone({
          type: 'batch' as const,
          sessionId: 'session-a',
          latestTurn: turn,
          actionablePromptIds: prompts,
          working: true,
          batch: { cursor: state.cursor!, items: [changed], removedItemIds: [], submissions: [] }
        })
      })
    }
    const shown = transcript()
    const output = project(shown, optimistic, state.submissions)
    expect(output.at(-1)?.blocks).toEqual([{ type: 'text', text: 'tail 2' }])
    expect(output.at(-2)?.blocks).toEqual([{ type: 'text', text: 'other' }])
    expect(output[0]).toBe(messages[0])
    expect(receipts(shown).receipts).toBe(initialReceipts)
    expect(state.latestTurn).toBe(turn)
    expect(state.actionablePromptIds).toBe(prompts)
    expect(state.hasOlder).toBe(true)
    expect(reads).toBeLessThan(100)
    // A real host change must still invalidate the identities.
    const changedWork = reduceStructuredAgentSession(state, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        latestTurn: null,
        actionablePromptIds: [],
        working: false,
        batch: { cursor: state.cursor!, items: [], removedItemIds: [], submissions: [] }
      }
    })
    expect(changedWork.latestTurn).toBeNull()
    expect(changedWork.actionablePromptIds).toEqual([])
    expect(changedWork.working).toBe(false)
  }
})
