import { expect, it } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredSessionQueuedMessage } from './structured-session-queued-message'

it.each([
  ['queued', 'pending', true],
  ['dispatching', 'submitting', false],
  ['unconfirmed', 'uncertain', false]
] as const)(
  'projects %s without making an in-flight message editable',
  (state, projected, editable) => {
    const entry = createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'message-1',
      sessionId: 'session-1',
      text: 'hello',
      attachments: [{ path: '/image.png', previewUri: '/image.png' }],
      queuedAt: 1
    })
    expect(structuredSessionQueuedMessage({ ...entry, state })).toEqual({
      id: 'message-1',
      text: 'hello',
      imagePaths: ['/image.png'],
      state: projected,
      canEdit: editable,
      canRemove: editable
    })
  }
)
