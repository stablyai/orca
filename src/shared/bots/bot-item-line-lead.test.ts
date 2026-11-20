import { expect, it } from 'vitest'
import { botItemLineLead, type BotItemQuestionShape } from './bot-item-ask'

const decision = (question: string) => ({ question, replies: [] })

it('tells apart question lines that share a first line, and keeps the short lead otherwise', () => {
  const shape: BotItemQuestionShape = {
    body: '',
    decisions: [decision('Target?\nStaging'), decision('Target?\nProduction'), decision('Ship it?')]
  }
  expect(botItemLineLead(shape, shape.decisions[0]!)).toBe('Target? Staging →')
  expect(botItemLineLead(shape, shape.decisions[1]!)).toBe('Target? Production →')
  expect(botItemLineLead(shape, shape.decisions[2]!)).toBe('Ship it? →')
})
