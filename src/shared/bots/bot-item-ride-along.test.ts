import { describe, expect, it } from 'vitest'
import { botItemQuestionShape, type BotItemAsk } from './bot-item-ask'
import { botItemRideAlongText } from './bot-item-answer-lines'
import { botItemQuestionPairing } from './bot-item-question-answers'
import type { BotItem, BotItemEvent } from './bot-items'

const bot = { kind: 'bot', botId: 'b1', chatId: 'c1' } as const

function askEvent(prompts: string[]): BotItemEvent {
  const ask: BotItemAsk = {
    questions: prompts.map((prompt) => ({
      prompt,
      options: [{ label: 'Yes' }, { label: 'No' }]
    }))
  }
  return { id: 'e1', kind: 'commented', actor: bot, data: { text: '', ask }, at: 1 }
}

/** The lines each owner comment answers once read back after the ask, in order. */
function readBackEach(prompts: string[], texts: string[]): number[][] {
  const events: BotItemEvent[] = [
    askEvent(prompts),
    { id: 'e2', kind: 'status', actor: bot, data: { to: 'needs_you' }, at: 1 },
    ...texts.map((text, at) => ({
      id: `e${at + 3}`,
      kind: 'commented' as const,
      actor: { kind: 'owner' as const },
      data: { text },
      at: at + 2
    }))
  ]
  const item: Pick<BotItem, 'question' | 'status'> = {
    status: 'needs_you',
    question: { eventId: 'e1', text: '' }
  }
  const entry = botItemQuestionPairing(item, events).questions.get('e1')!
  return texts.map((_, at) =>
    entry.answers.flatMap((answer, index) => (answer?.id === `e${at + 3}` ? [index] : []))
  )
}

/** The lines a comment answers once it is read back after the ask. */
function readBack(prompts: string[], text: string): number[] {
  const ask = askEvent(prompts)
  const events: BotItemEvent[] = [
    ask,
    { id: 'e2', kind: 'status', actor: bot, data: { to: 'needs_you' }, at: 1 },
    { id: 'e3', kind: 'commented', actor: { kind: 'owner' }, data: { text }, at: 2 }
  ]
  const item: Pick<BotItem, 'question' | 'status'> = {
    status: 'needs_you',
    question: { eventId: 'e1', text: '' }
  }
  const entry = botItemQuestionPairing(item, events).questions.get('e1')!
  return entry.answers.flatMap((answer, index) => (answer ? [index] : []))
}

describe('botItemRideAlongText', () => {
  it('keeps a recovered "B → …" line from answering B', () => {
    const prompts = ['A?', 'B?', 'C?']
    const shape = botItemQuestionShape(askEvent(prompts).data)
    const text = botItemRideAlongText(shape, [null, null, 'Yes'], 'B? → old answer')
    expect(text).toBe('C? → Yes\n> B? → old answer')
    expect(readBack(prompts, text)).toEqual([2])
  })

  it('quotes again when a quoted line would answer another prompt', () => {
    // "> > B?" reads as "> B?", so one quote would make the line answer it.
    const prompts = ['A?', 'B?', '> > B?']
    const shape = botItemQuestionShape(askEvent(prompts).data)
    const text = botItemRideAlongText(shape, ['Yes', null, null], 'B? → old answer')
    expect(text).toBe('A? → Yes\n> > B? → old answer')
    expect(readBack(prompts, text)).toEqual([0])
  })

  it('leaves every other line as typed', () => {
    const prompts = ['A?', 'B?']
    const shape = botItemQuestionShape(askEvent(prompts).data)
    const words = 'Thanks.\n  B? is fine → really\nSee you'
    expect(botItemRideAlongText(shape, ['No', null], words)).toBe(`A? → No\n${words}`)
    expect(readBack(prompts, botItemRideAlongText(shape, ['No', null], words))).toEqual([0])
  })

  it('answers no line by order when every line it names was answered first', () => {
    // Another client answered C after the picks were composed, before the host wrote them.
    const prompts = ['A?', 'B?', 'C?']
    const shape = botItemQuestionShape(askEvent(prompts).data)
    const late = botItemRideAlongText(shape, [null, null, 'No'], 'B? → old answer')
    expect(readBackEach(prompts, ['C? → Yes', late])).toEqual([[2], []])
  })

  it('still reads a comment that names no line by order', () => {
    expect(readBackEach(['A?', 'B?'], ['A? → Yes', 'Sounds good'])).toEqual([[0], [1]])
  })
})
