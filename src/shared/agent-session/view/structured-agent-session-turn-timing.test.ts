import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import {
  selectStructuredAgentTurnBars,
  structuredAgentTurnLocalStartedAt
} from './structured-agent-session-turn-timing'

it('anchors work to the turn start even when its opener already has a receipt', () => {
  const send: AgentJournalSubmission = {
    clientMessageId: 'opener',
    fence: 2,
    payloadFingerprint: 'test',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1000,
    resolvedAt: null,
    handedOverAt: 1400,
    writtenAt: 1500
  }
  const user: AgentJournalRenderItem = {
    itemId: 'orca:opener',
    revision: 1,
    sequence: 1,
    observedAt: 1000,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Hello' }] }
  }
  expect(selectStructuredAgentTurnBars([user], [send], null).runningTiming).toBeNull()
  const turn: AgentJournalRenderItem = {
    itemId: 'orca:turn-row',
    revision: 1,
    sequence: 3,
    observedAt: 3800,
    turnScope: { kind: 'thread' },
    body: {
      kind: 'turn',
      turnId: 'turn',
      state: 'running',
      userItemId: 'orca:opener',
      writtenAt: 1500,
      startedAt: 3500
    }
  }
  const { runningTiming } = selectStructuredAgentTurnBars([user, turn], [send], 'turn')
  expect(runningTiming).toEqual({ state: 'running', startedAt: 3500, observedAt: 3800 })
  expect(structuredAgentTurnLocalStartedAt(runningTiming!, 10_000, 4000)).toBe(9500)
})
