import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './journal/agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'

it('retires off-page turn projections without discarding authoritative session state', () => {
  const items: AgentJournalRenderItem[] = Array.from({ length: 2000 }, (_, index) => ({
    itemId: `row-${index}`,
    revision: 1,
    sequence: index + 1,
    observedAt: index,
    body:
      index === 0
        ? { kind: 'turn', turnId: 'turn', state: 'completed' }
        : { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] }
  }))
  const state = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    items,
    status: 'ready' as const,
    retainedOwnItemLimit: 2000,
    retainedItemCap: 8000,
    cursor: { epoch: 'epoch', sequence: 2000 },
    latestTurn: {
      itemId: 'off-page-turn',
      observedAt: 0,
      turn: { turnId: 'turn', state: 'completed' as const }
    },
    working: false,
    actionablePromptIds: ['approval'],
    queuedMessages: [],
    unloadedTurnRevisions: 4
  }
  const trimmed = reduceStructuredAgentSession(state, { type: 'trim-history' })
  expect(trimmed.items).toHaveLength(1024)
  expect(trimmed.items[0]?.itemId).toBe('row-976')
  expect(trimmed.unloadedTurnRevisions).toBe(5)
  expect(trimmed.latestTurn).toEqual({
    itemId: 'off-page-turn',
    observedAt: 0,
    turn: { turnId: 'turn', state: 'completed' }
  })
  expect(trimmed.cursor).toEqual({ epoch: 'epoch', sequence: 2000 })
  expect(trimmed.actionablePromptIds).toEqual(['approval'])
  expect(trimmed.queuedMessages).toEqual([])
  expect(trimmed.hasOlder).toBe(true)
})
