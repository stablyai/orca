import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'

export function modelRefusalReadStates() {
  const before = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    cursor: { epoch: 'read-epoch', sequence: 1 }
  }
  const after: typeof before = {
    ...before,
    cursor: { epoch: 'read-epoch', sequence: 3 },
    items: [
      {
        itemId: agentJournalSubmissionKey('model-failure'),
        revision: 0,
        sequence: 2,
        observedAt: 2,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      }
    ],
    submissions: [
      {
        clientMessageId: 'model-failure',
        fence: 1,
        payloadFingerprint: 'p',
        providerItemId: null,
        dispatchState: 'rejected',
        submittedAt: 2,
        resolvedAt: 3,
        ...agentSessionFailureWords(
          { kind: 'providerRejected', detail: { text: 'unknown model id', audience: 'person' } },
          { surface: 'rejection', agentName: 'Grok' }
        )
      }
    ]
  }
  return { before, after }
}
