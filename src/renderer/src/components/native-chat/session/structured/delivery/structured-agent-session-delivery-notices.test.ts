import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

const send = (handedOverAt: number): AgentJournalSubmission => ({
  clientMessageId: 'c1',
  fence: 1,
  payloadFingerprint: 'f',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 1_000,
  resolvedAt: null,
  handoverRecorded: true,
  handedOverAt
})

function sendingIds(submission: AgentJournalSubmission): string[] {
  const notices = structuredAgentSessionDeliveryNotices({
    pending: [],
    submissions: [submission],
    agentName: 'Claude',
    startFailures: [],
    latestTurn: null
  })
  return [...notices].filter(([, notice]) => notice.sending === true).map(([id]) => id)
}

describe('structured agent session "Sending…"', () => {
  // The provider's first reply can take many seconds; the turn has started by then.
  it('clears once the message is handed to an idle agent', () => {
    expect(sendingIds(send(1_050))).toEqual([])
  })
})
