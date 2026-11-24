import { expect, it } from 'vitest'
import {
  botItemPickedReplies,
  botItemQuestionShape,
  type BotItemQuestionShape
} from './bot-item-ask'
import { botItemQuestionPairing } from './bot-item-question-answers'
import type { BotItemEvent } from './bot-items'
import {
  botItemAnswersText,
  botItemHeldAnswersText,
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
  // Held with the first still open, the second stays on its own line.
  const later = [null, 'none yet']
  expect(botItemNamedAnswers(shape, botItemHeldAnswersText(shape, later))).toEqual(later)
  // Posted with the first left out, the second keeps its place too; a place after the last answer
  // isn't written, and no answers write nothing.
  expect(botItemAnswersText(shape, later)).toBe('Target? →\nTarget? → none yet')
  expect(botItemNamedAnswers(shape, botItemAnswersText(shape, later))).toEqual(later)
  expect(botItemAnswersText(shape, ['the internal ones', null])).toBe('Target? → the internal ones')
  expect(botItemAnswersText(shape, [null, null])).toBe('')
})

it('leaves out of a recovery the lines a comment already answered', () => {
  expect(botItemUnsentAnswers(['Yes', 'No', null], ['Maybe', null, null])).toEqual([
    null,
    'No',
    null
  ])
})

it('reads answers and drafts written with the question line older builds wrote', () => {
  const ask = {
    questions: [
      { prompt: 'Rename `__init__` loader?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { prompt: 'Keep `_private_` helper?', options: [{ label: 'Yes' }, { label: 'No' }] }
    ]
  }
  const shape = botItemQuestionShape({ ask })
  // What a v1.4.272 phone, server or draft holds: code spans lost their `_` pairs.
  const both = 'Rename init loader? → Yes\nKeep private helper? → drop it'
  expect(botItemNamedAnswers(shape, both)).toEqual(['Yes', 'drop it'])
  expect(botItemPickedReplies(shape, { text: 'Keep private helper? → No' })[1]).toEqual([
    { label: 'No', recommended: false }
  ])
  const events: BotItemEvent[] = [
    {
      id: 'e1',
      kind: 'commented',
      actor: { kind: 'bot', botId: 'b', chatId: 'c' },
      data: { ask },
      at: 1
    },
    {
      id: 'e2',
      kind: 'commented',
      actor: { kind: 'owner' },
      data: { text: 'Keep private helper? → No' },
      at: 2
    }
  ]
  const answers = botItemQuestionPairing({ status: 'needs_you' }, events).questions.get(
    'e1'
  )?.answers
  expect(answers?.map((event) => event?.id ?? null)).toEqual([null, 'e2'])
})

it("keeps a line on the question it names when another's old line reads the same", () => {
  const shape = botItemQuestionShape({
    ask: {
      questions: [
        { prompt: 'Keep `_private_` helper?', options: [{ label: 'No' }] },
        { prompt: 'Keep private helper?', options: [{ label: 'No' }] }
      ]
    }
  })
  const held = botItemHeldAnswersText(shape, [null, 'drop it'])
  expect(botItemNamedAnswers(shape, held)).toEqual([null, 'drop it'])
  expect(botItemPickedReplies(shape, { text: 'Keep private helper? → No' })).toEqual([
    [],
    [{ label: 'No', recommended: false }]
  ])
  // A shorter current head that also matches leaves a longer old one its line.
  const lead = botItemQuestionShape({
    ask: {
      questions: [
        { prompt: 'Keep', options: [] },
        { prompt: 'Keep → `_x_`?', options: [] }
      ]
    }
  })
  expect(botItemNamedAnswers(lead, 'Keep → x? → No')).toEqual([null, 'No'])
})
