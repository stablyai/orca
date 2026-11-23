import { expect, it } from 'vitest'
import type { BotItemQuestionShape } from './bot-item-ask'
import {
  botItemAnswersText,
  botItemNamedAnswers,
  botItemUnsentAnswers
} from './bot-item-answer-lines'

it('keeps each answer on its own line when two questions share a first line', () => {
  const shape: BotItemQuestionShape = {
    body: '',
    decisions: [
      { question: '# Target?\nStaging hosts', replies: [] },
      { question: 'Target?\nProduction hosts', replies: [] }
    ]
  }
  const answers = ['the internal ones', 'none yet']
  expect(botItemNamedAnswers(shape, botItemAnswersText(shape, answers))).toEqual(answers)
  // With the first still open, the second stays on its own line.
  const later = [null, 'none yet']
  expect(botItemNamedAnswers(shape, botItemAnswersText(shape, later))).toEqual(later)
})

it('leaves out of a recovery the lines a comment already answered', () => {
  expect(botItemUnsentAnswers(['Yes', 'No', null], ['Maybe', null, null])).toEqual([
    null,
    'No',
    null
  ])
})
