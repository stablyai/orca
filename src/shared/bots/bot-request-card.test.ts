import { describe, expect, it } from 'vitest'
import { botRequestCardText, type BotRequestCard } from './bot-request-card'

const ask: BotRequestCard = {
  toBotId: 'docs',
  toBotName: 'Docs',
  purpose: 'question',
  subject: 'Where is the guide?',
  messageId: 'mail_1'
}

describe('the plain line for a client that cannot draw the card', () => {
  it('names the paired computer an ask went to', () => {
    const card = { ...ask, client: { installationId: 'inst', computer: 'Studio Mac' } }
    expect(botRequestCardText(card)).toBe('Asked Docs on Studio Mac: Where is the guide?')
  })

  it.each(['', '   '])('never reads "on :" when the computer name is %j', (computer) => {
    const card = { ...ask, client: { installationId: 'inst', computer } }
    expect(botRequestCardText(card)).toBe('Asked Docs on a paired computer: Where is the guide?')
    expect(botRequestCardText({ ...card, messageId: undefined, refusal: 'not_listening' })).toBe(
      'Not sent to Docs on a paired computer: Where is the guide?'
    )
  })

  it('names no computer for an ask on this Orca', () => {
    expect(botRequestCardText(ask)).toBe('Asked Docs: Where is the guide?')
  })
})
