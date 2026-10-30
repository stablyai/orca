import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { nativeChatForkEligibleItemIds } from './native-chat-fork-eligibility'

const turn = (
  id: string,
  state: 'completed' | 'running',
  outcome?: 'success' | 'failure'
): AgentJournalRenderItem => ({
  itemId: id,
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: id, providerTurnId: id, state, ...(outcome ? { outcome } : {}) }
})
const answer = (id: string, turnItemId: string): AgentJournalRenderItem => ({
  itemId: id,
  revision: 1,
  sequence: 2,
  observedAt: 2,
  turnScope: { kind: 'turn', turnItemId },
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] }
})

describe('nativeChatForkEligibleItemIds', () => {
  it('offers completed successful root answers while a later turn runs, never lifecycle rows', () => {
    expect([
      ...nativeChatForkEligibleItemIds([
        turn('A', 'completed', 'success'),
        answer('answer-A', 'A'),
        turn('B', 'completed', 'success'),
        answer('answer-B', 'B'),
        turn('C', 'running'),
        answer('answer-C', 'C'),
        { ...answer('child-answer', 'A'), agentId: 'child' },
        turn('failed', 'completed', 'failure'),
        answer('failed-answer', 'failed'),
        turn('unknown', 'completed'),
        answer('unknown-answer', 'unknown')
      ])
    ]).toEqual(['answer-A', 'answer-B'])
  })
})
