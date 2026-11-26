import { describe, expect, it } from 'vitest'
import {
  answerBotOffer,
  answerBotOfferAgain,
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
