import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './journal/agent-session-journal-types'
import { agentSessionCurrentContextRows } from './agent-session-context-clear'

import { activeStructuredAgentSessionTurnId } from './view/structured-agent-session-live-turn'

import { owesStructuredAgentSessionWork } from './view/structured-agent-session-owed-work'

const boundary = { operationId: 'clear', afterFence: 3, clearedAt: 100 }
const row = (sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem => ({
  itemId: `row-${sequence}`,
  sequence,
  revision: 1,
  observedAt: sequence,
  body
})
const clear = row(5, {
  kind: 'status',
  text: 'Localized fallback',
  presentation: 'context-cleared',
  contextClear: boundary
})
const oldSend: AgentJournalSubmission = {
  clientMessageId: 'old-send',
  fence: 3,
  payloadFingerprint: 'same',
  dispatchState: 'unknown',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null,
  acceptedSequence: 2
}
const user = row(1, {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Prior prompt' }]
})

describe('completed context clear projections', () => {
  it('includes new sends but excludes older unknown sends even at the current fence', () => {
    const currentSend = { ...oldSend, clientMessageId: 'new-send', acceptedSequence: 6 }
    const boundarySend = { ...oldSend, clientMessageId: 'boundary-send', acceptedSequence: 5 }
    const rows = [user, clear, row(7, { kind: 'turn', turnId: 'new-turn', state: 'running' })]
    expect(agentSessionCurrentContextRows(rows, [oldSend, boundarySend, currentSend])).toEqual({
      items: [rows[2]],
      submissions: [currentSend],
      sequence: clear.sequence
    })
    expect(activeStructuredAgentSessionTurnId(rows)).toBe('new-turn')
    expect(owesStructuredAgentSessionWork(rows, [oldSend, currentSend], 3)).toBe(true)
  })
})
