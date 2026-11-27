import { expect, it } from 'vitest'
import {
  answerBotOffer,
  withBotOfferAnswer,
  type BotOfferAnswer,
  type BotOfferAnswerUpdate
} from '../../../../shared/bots/bot-offer-answers'
import { isLostHostAnswer } from '@/runtime/provider-accounts/sign-in/runtime-host-account-sign-in-client'

// The desktop's card answer to a paired server, whose reply is lost after the server took it.
it('tells the agent once when the reply to a card answer is lost and the card is pressed again', async () => {
  let answers: BotOfferAnswer[] = []
  const told: string[] = []
  let lose = true
  const ops = {
    update: async (offerAnswer: BotOfferAnswerUpdate) => {
      answers = withBotOfferAnswer(answers, offerAnswer)
    },
    send: async () => {
      told.push('Dismiss')
      if (lose) {
        throw new Error('Runtime request timed out before bots.offer.answer completed')
      }
      return true
    },
    deliveryUnknown: isLostHostAnswer
  }
  const press = { cardId: 'card', dismissed: true } as const
  await expect(answerBotOffer(press, ops)).rejects.toThrow('timed out')
  lose = false
  expect(await answerBotOffer(press, ops)).toBe('already_answered')
  expect(told).toEqual(['Dismiss'])
})
