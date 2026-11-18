import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../agent-session/journal/agent-session-journal-types'
import { queuedMessageWithEdit } from './queued-message-edit'

const DELIVERED: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'labelled' }],
  origin: 'connector',
  asker: {
    source: 'slack',
    userId: 'U0SAM',
    role: 'member',
    place: { kind: 'public_channel', id: 'C9' }
  }
}

describe('editing a queued message Orca delivered from a connector', () => {
  it('drops the delivery mark and its tag once the person changes the text', () => {
    expect(queuedMessageWithEdit(DELIVERED, { text: 'mine now' })).toEqual({
      ok: true,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'mine now' }] }
    })
    expect(queuedMessageWithEdit(DELIVERED, { text: 'mine now', images: [] })).toEqual({
      ok: true,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'mine now' }] }
    })
  })

  it('keeps it when nothing changed', () => {
    expect(queuedMessageWithEdit(DELIVERED, { text: 'labelled' })).toEqual({
      ok: true,
      body: DELIVERED
    })
  })
})
