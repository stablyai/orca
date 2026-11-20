import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { selectStructuredAgentSettledTurns } from './structured-agent-session-turn-timing'

describe('structured agent turn "Worked for"', () => {
  // "Sending…" clears when the idle agent takes the write, so the clock the user watched began there.
  it('counts from when the agent took the opening send, not from its first reply', () => {
    const items: AgentJournalRenderItem[] = [
      {
        itemId: 'orca:c1',
        revision: 0,
        sequence: 1,
        observedAt: 9_000,
        body: { kind: 'message', role: 'user', blocks: [] }
      },
      {
        itemId: 't1',
        revision: 0,
        sequence: 2,
        observedAt: 25_000,
        body: {
          kind: 'turn',
          turnId: 't1',
          state: 'completed',
          userItemId: 'orca:c1',
          requestedAt: 9_000,
          startedAt: 25_000,
          completedAt: 40_000
        }
      }
    ]
    const submissions: AgentJournalSubmission[] = [
      {
        clientMessageId: 'c1',
        fence: 1,
        payloadFingerprint: 'f',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 9_000,
        resolvedAt: 25_000,
        handedOverAt: 9_000,
        writtenAt: 10_000
      }
    ]
    expect(
      selectStructuredAgentSettledTurns(items, submissions).get('orca:c1')?.workedSeconds
    ).toBe(30)
  })
})
