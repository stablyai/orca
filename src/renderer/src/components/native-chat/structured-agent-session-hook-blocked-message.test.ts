// A message the person's own agent hook refused is drawn as sent on the desktop: no notice, no
// Retry, and no "not sent", whether this desktop sent it or another device did.

import { expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const ID = 'op-blocked'
const KEY = agentJournalSubmissionKey(ID)
const ITEM: AgentJournalRenderItem = {
  itemId: KEY,
  revision: 0,
  sequence: 5,
  observedAt: 5,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'paste the key' }] }
}
const BLOCKED: AgentJournalSubmission = {
  clientMessageId: ID,
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'rejected',
  providerItemId: null,
  submittedAt: 4,
  resolvedAt: 7,
  handoverRecorded: true,
  handedOverAt: 5,
  ...agentSessionFailureWords(
    agentSessionFailureFact('hookBlocked', {
      detail: { text: 'No secrets in prompts.', audience: 'person' }
    }),
    { surface: 'rejection', agentName: 'Codex' }
  )
}
/** This desktop's own copy, as the send left it before the rejection was read. */
const OWN_COPY = {
  ...createStructuredAgentSessionOutboxEntry({
    clientMessageId: ID,
    sessionId: 'session-1',
    text: 'paste the key',
    attachments: [],
    queuedAt: 4
  }),
  state: 'dispatching' as const,
  lastAttemptAt: 4
}

it.each([
  ['another device sent it', []],
  ['this desktop sent it and still holds its copy', [OWN_COPY]]
])(
  'draws a hook-blocked message as sent, with no notice and no Retry, when %s',
  (_case, outbox) => {
    const rows = projectStructuredAgentSessionMessages([ITEM], outbox, [BLOCKED], [])
    expect(rows.map(({ id }) => id)).toEqual([KEY])
    expect(rows[0]).not.toHaveProperty('unsent')

    const notices = structuredAgentSessionDeliveryNotices(
      outbox,
      'Codex',
      vi.fn(),
      [BLOCKED],
      [],
      new Set(),
      [],
      new Set(),
      [ITEM],
      true
    )
    expect(notices.get(KEY)).toBeUndefined()
  }
)
