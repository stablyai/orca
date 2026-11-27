import { describe, expect, it } from 'vitest'
import {
  answerBotOffer,
  answerBotOfferAgain,
  botOfferAnswerKey,
  withBotOfferAnswer,
  type BotOfferAnswer,
  type BotOfferAnswerUpdate
} from './bot-offer-answers'

// The host's copy of the bot's answers, updated the way bots.update applies an offerAnswer.
function host(answers: BotOfferAnswer[]) {
  const sent: string[] = []
  return {
    answers: () => answers,
    sent,
    ops: (text: string, accepted = true) => ({
      update: async (offerAnswer: BotOfferAnswerUpdate) => {
        answers = withBotOfferAnswer(answers, offerAnswer)
      },
      send: async () => {
        if (accepted) {
          sent.push(text)
        }
        return { sent: accepted }
      }
    })
  }
}

const answered: BotOfferAnswer = { cardId: 'card', sent: { chosen: ['me@x.com'] } }

describe('a further action on an answered offer card', () => {
  it('is refused as a first answer, but goes through as another one', async () => {
    const card = host([answered])
    const side = { cardId: 'card', sent: { chosen: ['side@x.com'] } }
    expect(await answerBotOffer(side, card.ops('Use side'))).toBe('already_answered')
    expect(card.sent).toEqual([])
    expect(await answerBotOfferAgain(side, answered, card.ops('Use side'))).toBe('sent')
    expect(card.sent).toEqual(['Use side'])
    expect(card.answers()).toEqual([{ ...side, revision: 1 }])
  })

  it('puts the previous answer back when the chat refuses it', async () => {
    const card = host([answered])
    const side = { cardId: 'card', sent: { chosen: ['side@x.com'] } }
    expect(await answerBotOfferAgain(side, answered, card.ops('Use side', false))).toBe('refused')
    expect(card.answers()).toEqual([{ ...answered, revision: 0 }])
  })
})

describe('a first answer whose send outcome is unknown', () => {
  it('keeps the claim after a lost reply, but gives it back after a definite failure', async () => {
    const lost = new Error('reply lost')
    const card = host([])
    const press = (error: Error) =>
      answerBotOffer(
        { cardId: 'card', dismissed: true },
        {
          ...card.ops('Dismiss'),
          send: async () => {
            throw error
          },
          deliveryUnknown: (caught) => caught === lost
        }
      )

    await expect(press(new Error('not connected'))).rejects.toThrow('not connected')
    expect(card.answers()).toEqual([{ cardId: 'card' }])

    await expect(press(lost)).rejects.toThrow('reply lost')
    expect(card.answers()).toEqual([{ cardId: 'card', dismissed: true }])
    // The host may have queued it, so a second press tells the bot nothing.
    expect(await answerBotOffer({ cardId: 'card', dismissed: true }, card.ops('Dismiss'))).toBe(
      'already_answered'
    )
    expect(card.sent).toEqual([])
  })
})

describe('the answer key a card answer carries', () => {
  it('is the same for every press of one answer, and new for each further action', async () => {
    const keys: string[] = []
    const card = host([])
    const ops = (accepted: boolean) => ({
      ...card.ops('Import', accepted),
      send: async (answerKey: string) => (keys.push(answerKey), { sent: accepted })
    })
    const entry = () => card.answers().find((answer) => answer.cardId === 'card')
    // A refused first press gives the card back; the next press keys the same answer, whatever it chose.
    expect(await answerBotOffer({ cardId: 'card', sent: { chosen: ['ws-1'] } }, ops(false))).toBe(
      'refused'
    )
    expect(await answerBotOffer({ cardId: 'card', sent: { chosen: ['ws-2'] } }, ops(true))).toBe(
      'sent'
    )
    expect(keys[1]).toBe(keys[0])

    // Each further action is the card's next revision, even one that picks an earlier choice again.
    const further = (chosen: string) =>
      answerBotOfferAgain({ cardId: 'card', sent: { chosen: [chosen] } }, entry(), ops(true))
    await further('ws-3')
    await further('ws-2')
    await further('ws-3')
    expect(keys).toEqual([
      botOfferAnswerKey('card', 'sent'),
      botOfferAnswerKey('card', 'sent'),
      botOfferAnswerKey('card', 'sent', 1),
      botOfferAnswerKey('card', 'sent', 2),
      botOfferAnswerKey('card', 'sent', 3)
    ])
    expect(entry()).toEqual({ cardId: 'card', sent: { chosen: ['ws-3'] }, revision: 3 })
    expect(botOfferAnswerKey('card', 'dismissed')).not.toBe(keys[0])
  })

  it('takes back the choice the host already told the bot for that key', async () => {
    const card = host([])
    const told = await answerBotOffer(
      { cardId: 'card', sent: { chosen: ['ws-2'] } },
      { ...card.ops('Import'), send: async () => ({ sent: true, chosen: ['ws-1'] }) }
    )
    expect(told).toBe('sent')
    expect(card.answers()).toEqual([{ cardId: 'card', sent: { chosen: ['ws-1'] } }])
  })
})
