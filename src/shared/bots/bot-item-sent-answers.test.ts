import { describe, expect, it } from 'vitest'
import type { BotItemQuestionShape } from './bot-item-ask'
import type { BotItemPendingComment } from './bot-item-pending-comments'
import { botItemPendingAnswersOnly, botItemSentAnswers } from './bot-item-sent-answers'

const several: BotItemQuestionShape = {
  body: '',
  decisions: [
    { question: 'A?', replies: [{ label: 'Yes', recommended: false }] },
    { question: 'B?', replies: [{ label: 'Yes', recommended: false }] }
  ]
}
const one: BotItemQuestionShape = { body: '', decisions: [several.decisions[0]!] }

function entry(
  text: string,
  intent: BotItemPendingComment['intent'],
  failed = false
): BotItemPendingComment {
  return {
    event: {
      id: `pending:${text}`,
      kind: 'commented',
      actor: { kind: 'owner' },
      data: { text },
      at: 1
    },
    paths: [],
    after: 0,
    eventId: null,
    // An older host: no request or question ids on the wire.
    requestId: null,
    questionId: null,
    plain: false,
    failed,
    ...(intent ? { intent } : {})
  }
}

describe('botItemSentAnswers', () => {
  it('reads each send by the ask it was composed for, never by its words', () => {
    const sent = botItemSentAnswers([
      entry('A? → Yes', { askId: 'old', shape: several, answers: ['Yes', null] })
    ])
    // The replacement ask asks the same question: the old send is not its answer.
    expect(sent.get('new')).toBeUndefined()
    expect(sent.get('old')).toEqual(['Yes', null])
  })

  it('shows a bare quick reply on its line', () => {
    const sent = botItemSentAnswers([entry('Yes', { askId: 'q', shape: one, answers: ['Yes'] })])
    expect(sent.get('q')).toEqual(['Yes'])
  })

  it('keeps a failed send of several questions on its lines, not one of one question', () => {
    const sent = botItemSentAnswers([
      entry('A? → Yes', { askId: 'many', shape: several, answers: ['Yes', null] }, true),
      entry('Yes', { askId: 'single', shape: one, answers: ['Yes'] }, true)
    ])
    expect(sent.get('many')).toEqual(['Yes', null])
    expect(sent.get('single')).toBeUndefined()
  })

  it('ignores comments that answer nothing', () => {
    expect(botItemSentAnswers([entry('Thanks', undefined)]).size).toBe(0)
  })
})

describe('botItemPendingAnswersOnly', () => {
  it('leaves a send to its lines when its words are exactly its answers', () => {
    expect(
      botItemPendingAnswersOnly(
        entry('A? → Yes', { askId: 'q', shape: several, answers: ['Yes', null] })
      )
    ).toBe(true)
    expect(
      botItemPendingAnswersOnly(entry('Yes', { askId: 'q', shape: one, answers: ['Yes'] }))
    ).toBe(true)
  })

  it('shows words riding along, files, skills, or a failed send as its own comment', () => {
    const intent = { askId: 'q', shape: several, answers: ['Yes', null] }
    expect(botItemPendingAnswersOnly(entry('A? → Yes\nThanks', intent))).toBe(false)
    expect(botItemPendingAnswersOnly({ ...entry('A? → Yes', intent), paths: ['/tmp/a.png'] })).toBe(
      false
    )
    expect(
      botItemPendingAnswersOnly({
        ...entry('A? → Yes', intent),
        skills: [{ name: 'review', path: '/skills/review/SKILL.md' }]
      })
    ).toBe(false)
    const pill = '@/tmp/agent-session-attachments/0123abcd-0123-4567-89ab-0123456789ab/notes.txt'
    expect(
      botItemPendingAnswersOnly(
        entry(`A? → ${pill}`, { askId: 'q', shape: several, answers: [pill, null] })
      )
    ).toBe(false)
    expect(botItemPendingAnswersOnly(entry('A? → Yes', intent, true))).toBe(false)
    expect(botItemPendingAnswersOnly(entry('Thanks', undefined))).toBe(false)
  })
})
