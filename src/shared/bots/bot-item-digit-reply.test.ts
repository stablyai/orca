import { describe, expect, it } from 'vitest'
import { botItemQuestionShape } from './bot-item-ask'
import { botItemDigitReplyText } from './bot-item-digit-reply'
import type { BotItemEvent } from './bot-items'

function asked(ask: unknown, answered = false) {
  const shape = botItemQuestionShape({ ask })
  const reply: BotItemEvent = {
    id: 'e9',
    kind: 'commented',
    actor: { kind: 'owner' },
    data: { text: 'Ship it' },
    at: 0
  }
  return {
    shape,
    answers: shape.decisions.map(() => (answered ? reply : null)),
    waiting: true
  }
}

const options = [{ label: 'Ship it' }, { label: 'Hold' }]

describe('botItemDigitReplyText', () => {
  it('answers only an open ask of one question that picks one reply', () => {
    const one = asked({ questions: [{ prompt: 'Merge?', options, recommended: 0 }] })
    expect(botItemDigitReplyText(one, 1)).toBe('Ship it')
    expect(botItemDigitReplyText(one, 2)).toBe('Hold')
    expect(botItemDigitReplyText(one, 3)).toBeNull()
    expect(botItemDigitReplyText({ ...one, waiting: false }, 1)).toBeNull()
    expect(
      botItemDigitReplyText(asked({ questions: [{ prompt: 'Merge?', options }] }, true), 1)
    ).toBeNull()
    expect(
      botItemDigitReplyText(asked({ questions: [{ prompt: 'Pick', options, multi: true }] }), 1)
    ).toBeNull()
    // With several questions a digit can't say which one it answers.
    expect(
      botItemDigitReplyText(
        asked({
          questions: [
            { prompt: 'Merge?', options },
            { prompt: 'Deploy?', options }
          ]
        }),
        1
      )
    ).toBeNull()
    expect(botItemDigitReplyText(null, 1)).toBeNull()
  })
})
