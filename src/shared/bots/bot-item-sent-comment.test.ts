import { expect, it } from 'vitest'
import type { BotItemQuestionShape } from './bot-item-ask'
import type { BotItemPendingIntent } from './bot-item-pending-comments'
import { isBotItemSentComment, type BotItemSentAnswers } from './use-bot-item-question-steps'

const one: BotItemQuestionShape = {
  body: '',
  decisions: [{ question: 'Merge it?', replies: [{ label: 'Yes', recommended: false }] }]
}

it('names the comment the card posted, not another one with the same words', () => {
  const intent: BotItemPendingIntent = { askId: 'ask-1', shape: one, answers: ['Yes'] }
  const sent: BotItemSentAnswers = { askId: 'ask-1', text: 'Yes', answers: ['Yes'], intent }
  // The card's "Yes" was refused for a replaced question; a plain "Yes" typed in the box is on its way.
  const card = { failed: true, intent }
  const plain = { failed: false }
  expect(isBotItemSentComment(card, sent)).toBe(false)
  // The plain comment shows as itself, and the card's lines don't read as answered by it.
  expect(isBotItemSentComment(plain, sent)).toBe(false)
  expect(isBotItemSentComment({ failed: false, intent }, sent)).toBe(true)
})

it('names nothing when no answers were just sent', () => {
  const intent: BotItemPendingIntent = { askId: 'ask-1', shape: one, answers: ['Yes'] }
  expect(isBotItemSentComment({ failed: false, intent }, null)).toBe(false)
  expect(isBotItemSentComment({ failed: false }, null)).toBe(false)
})
