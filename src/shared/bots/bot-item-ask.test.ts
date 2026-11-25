import { describe, expect, it } from 'vitest'
import { botItemAskText, botItemQuestionLine, normalizeBotItemAsk } from './bot-item-ask'

describe('botItemQuestionLine', () => {
  it('skips a leading line that is only a Markdown mark', () => {
    expect(botItemQuestionLine('##\n\n**Merge** `__init__` now?')).toBe('Merge __init__ now?')
  })
})

const question = (labels: string[], recommended?: number, multi?: true) => ({
  prompt: 'Go?',
  options: labels.map((label) => ({ label })),
  ...(recommended === undefined ? {} : { recommended }),
  ...(multi ? { multi } : {})
})
const ask = (labels: string[], recommended?: number, multi?: true) =>
  normalizeBotItemAsk({ questions: [question(labels, recommended, multi)] }).questions[0]!
const labelsOf = (asked: ReturnType<typeof ask>) => asked.options.map((o) => o.label)

it('normalizes a written "(Recommended)" into the recommended flag, once', () => {
  // Written and flagged: the flag stays, the label loses the words.
  const both = ask(['Go (Recommended)', 'Wait'], 0)
  expect(labelsOf(both)).toEqual(['Go', 'Wait'])
  expect(both.recommended).toBe(0)
  // Written only: the one marked option becomes the recommendation.
  expect(ask(['Go', 'Wait [recommended]'])).toMatchObject({ recommended: 1 })
  // The flag wins over words on another option.
  expect(ask(['Go', 'Wait (recommended)'], 0)).toMatchObject({ recommended: 0 })
  // Two written and no flag: no guess, and the words stay as the only hint.
  const two = ask(['Go (Recommended)', 'Wait (Recommended)'])
  expect(labelsOf(two)).toEqual(['Go (Recommended)', 'Wait (Recommended)'])
  expect(two.recommended).toBeUndefined()
  // Two written with a flag: the flag decides, both labels are cleaned.
  expect(labelsOf(ask(['Go (Recommended)', 'Wait (Recommended)'], 1))).toEqual(['Go', 'Wait'])
  // A mark written twice goes whole, and cleaning again changes nothing.
  const twice = ask(['Deploy (Recommended) [recommended]', 'Wait'])
  expect(labelsOf(twice)).toEqual(['Deploy', 'Wait'])
  expect(normalizeBotItemAsk({ questions: [twice] }).questions[0]).toEqual(twice)
  // Pick several with no ", " in its labels is cleaned like pick one.
  expect(ask(['Audit (Recommended)', 'Notify'], undefined, true)).toMatchObject({
    options: [{ label: 'Audit' }, { label: 'Notify' }],
    recommended: 0
  })
})

it('leaves words that are not a clean mark, or a label cleaning would confuse, as written', () => {
  const asWritten = (labels: string[], recommended?: number, multi?: true) =>
    expect(ask(labels, recommended, multi)).toEqual(question(labels, recommended, multi))
  // Recommended inside a label, in a mismatched pair, or with no space before it is its words.
  asWritten(['The recommended fix', 'Wait'])
  asWritten(['Go (recommended]', 'Wait'])
  asWritten(['Go [recommended)', 'Wait'], 1)
  asWritten(['Go(Recommended)', 'Wait'])
  // Words it would empty.
  asWritten(['(Recommended)', 'Wait'])
  asWritten(['(Recommended)', 'Wait (Recommended)'])
  // A twin, in either order, by its words or as answers send it (spacing folded); no recommendation
  // is read from words that stay.
  asWritten(['Go', 'Go (Recommended)'])
  asWritten(['Go (Recommended)', 'Go [recommended]'], 1)
  asWritten(['Go [recommended]', 'Go (Recommended)'], 0)
  asWritten(['Deploy (Recommended) (Recommended)', 'Deploy'], 1)
  asWritten(['Ship  now (Recommended)', 'Ship now'])
  // Pick several whose labels hold ", ": its picks are joined that way.
  asWritten(['Audit', 'Notify', 'Audit, Notify (Recommended)'], undefined, true)
  asWritten(['Audit (Recommended)', 'Notify', 'Audit, Notify'], 0, true)
  asWritten(['A, B (Recommended)', 'C', 'A', 'B, C'], undefined, true)
  asWritten(['Audit,  Notify (Recommended)', 'Audit', 'Notify'], undefined, true)
  // Twins keep their words while a sibling is still cleaned.
  expect(labelsOf(ask(['Go (Recommended)', 'Go [recommended]', 'Wait (Recommended)'], 2))).toEqual([
    'Go (Recommended)',
    'Go [recommended]',
    'Wait'
  ])
  // Pick one: the same labels are cleaned, since its answer is one label.
  expect(labelsOf(ask(['Audit', 'Notify', 'Audit, Notify (Recommended)']))).toEqual([
    'Audit',
    'Notify',
    'Audit, Notify'
  ])
})

it('never makes the ask text longer than written', () => {
  const cases: [string[], number?][] = [
    [['Go (Recommended)', 'Wait']],
    [['Go [recommended]', 'Wait']],
    [['Go (Recommended)', 'Wait'], 1],
    [['Go (  recommended )', 'Wait (Recommended)'], 0],
    [['Deploy (Recommended) (Recommended)', 'Wait']],
    [['Go', 'Go (Recommended)']],
    [['Go(Recommended)', 'Wait']]
  ]
  for (const [labels, recommended] of cases) {
    const written = { questions: [question(labels, recommended)] }
    expect(botItemAskText(normalizeBotItemAsk(written)).length).toBeLessThanOrEqual(
      botItemAskText(written).length
    )
  }
})
