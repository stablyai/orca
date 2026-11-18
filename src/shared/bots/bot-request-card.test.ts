import { describe, expect, it } from 'vitest'
import { botRequestCardBody, botRequestCardOf } from './bot-request-card'

describe('bot request card', () => {
  const card = {
    toBotId: 'docs',
    toBotName: 'Docs',
    purpose: 'handoff' as const,
    subject: 'Fix it'
  }

  it('reads back what it wrote, with a line for clients that cannot draw it', () => {
    const sent = botRequestCardBody({ ...card, messageId: 'msg_1' })
    expect(sent.text).toBe('Handed to Docs: Fix it')
    expect(botRequestCardOf(sent)).toEqual({ ...card, messageId: 'msg_1' })
    expect(botRequestCardBody({ ...card, purpose: 'question', messageId: 'm' }).text).toBe(
      'Asked Docs: Fix it'
    )
    expect(botRequestCardBody({ ...card, refusal: 'bot_paused' }).text).toBe(
      'Not sent to Docs: Fix it'
    )
  })

  it('ignores a card this build cannot read', () => {
    expect(botRequestCardOf({ kind: 'status', text: 'x' })).toBeNull()
    const newer = { ...botRequestCardBody(card), botRequest: { ...card, purpose: 'delegate' } }
    expect(botRequestCardOf(newer)).toBeNull()
  })
})
