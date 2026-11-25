import { describe, expect, it } from 'vitest'
import { botItemQuestionLine, normalizeBotItemAsk } from './bot-item-ask'

describe('botItemQuestionLine', () => {
  it('skips a leading line that is only a Markdown mark', () => {
    expect(botItemQuestionLine('##\n\n**Merge** `__init__` now?')).toBe('Merge __init__ now?')
  })
})

it('normalizes a written "(Recommended)" into the recommended flag, once', () => {
  const ask = (labels: string[], recommended?: number, multi?: true) =>
    normalizeBotItemAsk({
      questions: [
        {
          prompt: 'Go?',
          options: labels.map((label) => ({ label })),
          ...(recommended === undefined ? {} : { recommended }),
          ...(multi ? { multi } : {})
        }
      ]
    }).questions[0]!
  const labelsOf = (question: ReturnType<typeof ask>) => question.options.map((o) => o.label)

  // Written and flagged: the flag stays, the label loses the words.
  const both = ask(['Go (Recommended)', 'Wait'], 0)
  expect(labelsOf(both)).toEqual(['Go', 'Wait'])
  expect(both.recommended).toBe(0)
  // Written only: the one marked option becomes the recommendation.
  expect(ask(['Go', 'Wait [recommended]']).recommended).toBe(1)
  // The flag wins over words on another option.
  expect(ask(['Go', 'Wait (recommended)'], 0)).toMatchObject({ recommended: 0 })
  // Two written and no flag: no guess, and the words stay as the only hint.
  const two = ask(['Go (Recommended)', 'Wait (Recommended)'])
  expect(labelsOf(two)).toEqual(['Go (Recommended)', 'Wait (Recommended)'])
  expect(two.recommended).toBeUndefined()
  // Two written with a flag: the flag decides, both labels are cleaned.
  expect(labelsOf(ask(['Go (Recommended)', 'Wait (Recommended)'], 1))).toEqual(['Go', 'Wait'])
  // Words it would empty stay as written.
  expect(labelsOf(ask(['(Recommended)', 'Wait']))).toEqual(['(Recommended)', 'Wait'])
  // A mark with no other words still counts: two marked and no flag, nothing is guessed.
  const bare = ask(['(Recommended)', 'Wait (Recommended)'])
  expect(labelsOf(bare)).toEqual(['(Recommended)', 'Wait (Recommended)'])
  expect(bare.recommended).toBeUndefined()
  // Recommended inside a label, or in a mismatched pair, is its words.
  expect(labelsOf(ask(['The recommended fix']))).toEqual(['The recommended fix'])
  const mismatched = ask(['Go (recommended]', 'Wait'])
  expect(labelsOf(mismatched)).toEqual(['Go (recommended]', 'Wait'])
  expect(mismatched.recommended).toBeUndefined()
  expect(labelsOf(ask(['Go [recommended)', 'Wait'], 1))).toEqual(['Go [recommended)', 'Wait'])
  // A mark written twice goes whole, and cleaning again changes nothing.
  const twice = ask(['Deploy (Recommended) [recommended]', 'Wait'])
  expect(labelsOf(twice)).toEqual(['Deploy', 'Wait'])
  expect(normalizeBotItemAsk({ questions: [twice] }).questions[0]).toEqual(twice)
})

it('keeps the words of options cleaning would make read alike', () => {
  const ask = (labels: string[], recommended?: number, multi?: true) =>
    normalizeBotItemAsk({
      questions: [
        {
          prompt: 'Go?',
          options: labels.map((label) => ({ label })),
          ...(recommended === undefined ? {} : { recommended }),
          ...(multi ? { multi } : {})
        }
      ]
    }).questions[0]!
  const labelsOf = (question: ReturnType<typeof ask>) => question.options.map((o) => o.label)

  // A twin keeps its words, yet the recommendation is still read from them.
  const twin = ask(['Go', 'Go (Recommended)'])
  expect(labelsOf(twin)).toEqual(['Go', 'Go (Recommended)'])
  expect(twin.recommended).toBe(1)
  // Twins keep their words in either order; a sibling is still cleaned.
  expect(labelsOf(ask(['Go (Recommended)', 'Go [recommended]', 'Wait (Recommended)'], 1))).toEqual([
    'Go (Recommended)',
    'Go [recommended]',
    'Wait'
  ])
  expect(labelsOf(ask(['Go [recommended]', 'Go (Recommended)', 'Wait (Recommended)'], 0))).toEqual([
    'Go [recommended]',
    'Go (Recommended)',
    'Wait'
  ])
  // Not the phone's twin either: it drops one "(Recommended)" from a label itself.
  expect(labelsOf(ask(['Deploy (Recommended) (Recommended)', 'Deploy'], 1))).toEqual([
    'Deploy (Recommended) (Recommended)',
    'Deploy'
  ])
  // Pick several: a label that would read like two siblings sent together keeps every label's words.
  const joined = ask(['Audit', 'Notify', 'Audit, Notify (Recommended)'], undefined, true)
  expect(labelsOf(joined)).toEqual(['Audit', 'Notify', 'Audit, Notify (Recommended)'])
  expect(joined.recommended).toBe(2)
  expect(labelsOf(ask(['Audit (Recommended)', 'Notify', 'Audit, Notify'], 0, true))).toEqual([
    'Audit (Recommended)',
    'Notify',
    'Audit, Notify'
  ])
  // Pick one: the same labels are cleaned, since its answer is one label.
  expect(labelsOf(ask(['Audit', 'Notify', 'Audit, Notify (Recommended)']))).toEqual([
    'Audit',
    'Notify',
    'Audit, Notify'
  ])
})
