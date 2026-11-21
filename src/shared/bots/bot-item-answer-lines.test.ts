import { describe, expect, it } from 'vitest'
import { botItemNamedAnswers } from './bot-item-answer-lines'
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
