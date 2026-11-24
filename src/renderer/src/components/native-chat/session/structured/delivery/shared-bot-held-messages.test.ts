import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  SharedBotHeldView,
  SharedBotHostView
} from '../../../../../../../shared/bots/shared-bot-hosts'
import { projectStructuredAgentSessionMessages } from '../../../conversation/projection/structured-agent-session-message-projection'
import { sharedBotHeldMessages } from './shared-bot-held-messages'

const WORDS = { waiting: (owner: string) => `Waiting for ${owner}’s computer`, notSent: 'Not sent' }

const held = (clientMessageId: string, state: SharedBotHeldView['state']): SharedBotHeldView => ({
  clientMessageId,
  sessionId: 'chat-0001',
  text: `message ${clientMessageId}`,
  attachments: [],
  sentAt: 5,
  state
})

const host = (messages: SharedBotHeldView[]): SharedBotHostView => ({
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  homeWorkspaceId: null,
  link: 'offline',
  holds: true,
  held: messages
})

describe('a teammate’s held messages in their chat', () => {
  it('draws each one with the cloud’s word on it, and Send again on one not sent', () => {
    const sendAgain = vi.fn()
    const { messages, notices } = sharedBotHeldMessages(
      host([
        held('m1', 'waiting'),
        held('m2', 'not_sent'),
        held('m3', 'delivered'),
        { ...held('m4', 'waiting'), sessionId: 'other-chat' }
      ]),
      'chat-0001',
      WORDS,
      sendAgain
    )
    const rows = projectStructuredAgentSessionMessages([], messages, [])
    expect(rows.map((row) => row.id)).toEqual(
      ['m1', 'm2', 'm3'].map((id) => agentJournalSubmissionKey(id))
    )
    expect(notices.get(agentJournalSubmissionKey('m1'))).toEqual({
      text: 'Waiting for Jinwoo Hong’s computer',
      waiting: true
    })
    const notSent = notices.get(agentJournalSubmissionKey('m2'))
    expect(notSent?.text).toBe('Not sent')
    notSent?.onSendAgain?.()
    expect(sendAgain).toHaveBeenCalledWith('m2')
    // Delivered: the host's own row takes over once read; until then it shows as sent.
    expect(notices.has(agentJournalSubmissionKey('m3'))).toBe(false)
  })

  it('draws a message of files alone, named, with its line', () => {
    const { messages, notices } = sharedBotHeldMessages(
      host([{ ...held('m1', 'waiting'), text: '', attachments: ['shot.png'] }]),
      'chat-0001',
      WORDS,
      () => {}
    )
    const rows = projectStructuredAgentSessionMessages([], messages, [])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.blocks).toEqual([{ type: 'text', text: 'shot.png' }])
    expect(notices.get(agentJournalSubmissionKey('m1'))?.waiting).toBe(true)
  })

  it('draws nothing for a chat on a host that isn’t shared', () => {
    const none = sharedBotHeldMessages(null, 'chat-0001', WORDS, () => {})
    expect(none.messages).toEqual([])
    expect(none.notices.size).toBe(0)
  })
})
