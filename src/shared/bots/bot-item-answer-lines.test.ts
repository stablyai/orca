import { describe, expect, it } from 'vitest'
import { botItemLineImages, botItemNamedAnswers } from './bot-item-answer-lines'
import type { BotItemQuestionShape } from './bot-item-ask'

const shape: BotItemQuestionShape = {
  body: '',
  decisions: [
    { question: 'Target?', replies: [] },
    { question: 'Target? → region?', replies: [] }
  ]
}

describe('botItemNamedAnswers', () => {
  it('gives a line to the question with the longest matching lead', () => {
    expect(botItemNamedAnswers(shape, 'Target? → region? → eu')).toEqual([null, 'eu'])
    expect(botItemNamedAnswers(shape, 'Target? → prod\nTarget? → region? → eu')).toEqual([
      'prod',
      'eu'
    ])
  })
})

it('names each image once per line, and reads a marker in code as words', () => {
  expect(botItemLineImages('see [Image #1] and again [Image #1]', 1)).toEqual([0])
  expect(botItemLineImages('chat writes `[Image #1]`', 1)).toEqual([])
})
