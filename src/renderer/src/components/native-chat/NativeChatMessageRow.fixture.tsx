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

export const dollars = defineFixture({
  width: 640,
  render: () => (
    <div className="native-chat-appearance space-y-4 p-4">
      <MessageRow
        message={{
          id: 'dollar-question',
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Can I use `$HOME/bin:$PATH`? It costs $5 or $10.' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={() => {}}
      />
      <MessageRow
        message={{
          id: 'dollar-answer',
          role: 'assistant',
          timestamp: 1,
          source: 'transcript',
          blocks: [
            {
              type: 'text',
              text: [
                'Set $ORCA_HOME then run echo $PATH. Use `$HOME/bin:$PATH` or `$HOME/${PATH}`. In PowerShell, use `$env:PATH;$env:TEMP`.',
                'Prices: $5 + tax$ stays as written. Inline code stays literal: `echo $HOME`.',
                String.raw`Real math: the $n$th term, $x^2$, $5+2$, and \(5 + 2\).`,
                '$$5 + 2$$'
              ].join('\n\n')
            }
          ]
        }}
        expandSignal={false}
        onScrollMessageToTop={() => {}}
      />
    </div>
  )
})
