import { describe, expect, it } from 'vitest'
import { botItemQuestionLine, normalizeBotItemAsk } from './bot-item-ask'

describe('botItemQuestionLine', () => {
  it('skips a leading line that is only a Markdown mark', () => {
    expect(botItemQuestionLine('##\n\n**Merge** `__init__` now?')).toBe('Merge __init__ now?')
  })
})

it('normalizes a written "(Recommended)" into the recommended flag, once', () => {
  const ask = (labels: string[], recommended?: number) =>
    normalizeBotItemAsk({
      questions: [
        {
          prompt: 'Go?',
          options: labels.map((label) => ({ label })),
          ...(recommended === undefined ? {} : { recommended })
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
  // A twin keeps its words, yet the recommendation is still read from them.
  const twin = ask(['Go', 'Go (Recommended)'])
  expect(labelsOf(twin)).toEqual(['Go', 'Go (Recommended)'])
  expect(twin.recommended).toBe(1)
  // A twin does not stop a sibling from being cleaned.
  expect(labelsOf(ask(['Go', 'Go (Recommended)', 'Wait (Recommended)'], 0))).toEqual([
    'Go',
    'Go (Recommended)',
    'Wait'
  ])
  // Recommended inside a label is its words.
  expect(labelsOf(ask(['The recommended fix']))).toEqual(['The recommended fix'])
})
