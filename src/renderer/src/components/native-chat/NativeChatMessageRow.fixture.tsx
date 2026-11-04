import { defineFixture } from '../../component-fixtures/component-fixture'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { MessageRow } from './NativeChatMessageRow'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'

function RecordedSteer({ state }: { state: AgentJournalSubmission['dispatchState'] }) {
  const notices = useStructuredAgentSessionDeliveryNotices({
    pending: [],
    submissions: [
      {
        clientMessageId: 'steer',
        fence: 1,
        payloadFingerprint: 'steer',
        dispatchState: state,
        providerItemId: null,
        reason: state === 'rejected' ? 'Codex refused the message.' : null,
        submittedAt: 1,
        resolvedAt: state === 'pending' ? null : 2,
        handoverRecorded: true
      }
    ],
    journalItems: [],
    agentName: 'Codex',
    startFailures: []
  })
  const id = agentJournalSubmissionKey('steer')
  return (
    <MessageRow
      message={{
        id,
        role: 'user',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Ignore failures outside this branch.' }]
      }}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
      deliveryNotice={notices.get(id)}
    />
  )
}

export const pending = defineFixture({
  width: 480,
  render: () => <RecordedSteer state="pending" />
})
export const accepted = defineFixture({
  width: 480,
  render: () => <RecordedSteer state="accepted" />
})
export const rejected = defineFixture({
  width: 480,
  render: () => <RecordedSteer state="rejected" />
})
