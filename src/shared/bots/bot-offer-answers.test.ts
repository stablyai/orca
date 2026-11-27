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
        return accepted
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
    expect(await answerBotOfferAgain(side, answered.sent, card.ops('Use side'))).toBe('sent')
    expect(card.sent).toEqual(['Use side'])
    expect(card.answers()).toEqual([side])
  })

  it('puts the previous answer back when the chat refuses it', async () => {
    const card = host([answered])
    const side = { cardId: 'card', sent: { chosen: ['side@x.com'] } }
    expect(await answerBotOfferAgain(side, answered.sent, card.ops('Use side', false))).toBe(
      'refused'
    )
    expect(card.answers()).toEqual([answered])
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
  it('is the same for every press of one answer, and differs between answers', async () => {
    const keys: string[] = []
    const card = host([])
    const ops = (accepted: boolean) => ({
      ...card.ops('Import', accepted),
      send: async (answerKey: string) => (keys.push(answerKey), accepted)
    })
    // A refused first press gives the card back; the next press keys the same answer.
    expect(await answerBotOffer({ cardId: 'card', sent: { chosen: ['ws-1'] } }, ops(false))).toBe(
      'refused'
    )
    expect(await answerBotOffer({ cardId: 'card', sent: { chosen: ['ws-2'] } }, ops(true))).toBe(
      'sent'
    )
    expect(keys[0]).toBe(keys[1])

    // A further action keys its own choice, so each one still reaches the bot.
    await answerBotOfferAgain(
      { cardId: 'card', sent: { chosen: ['ws-2', 'ws-3'] } },
      undefined,
      ops(true)
    )
    await answerBotOfferAgain(
      { cardId: 'card', sent: { chosen: ['ws-2', 'ws-4'] } },
      undefined,
      ops(true)
    )
    expect(new Set(keys.slice(1)).size).toBe(3)
    expect(botOfferAnswerKey('card', 'dismissed')).not.toBe(keys[0])
    expect(botOfferAnswerKey('other', 'sent')).not.toBe(keys[0])
  })
})
