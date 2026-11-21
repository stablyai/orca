import { expect, it } from 'vitest'
import { botItemPickedReplies, botItemQuestionShape, normalizeBotItemAsk } from './bot-item-ask'

const lead = {
  prompt: 'Which changes should lead the notes?',
  options: [
    { label: 'Agents on the phone' },
    { label: 'Docs' },
    { label: 'Docs, changelog' },
    { label: 'changelog, Vault autofill' }
  ],
  multi: true
}
const labels = (picks: { label: string }[][]): string[][] =>
  picks.map((line) => line.map((pick) => pick.label))

it('reads a pick-several answer sent as one reply as each of its picks', () => {
  const one = botItemQuestionShape({ ask: { questions: [lead] } })
  expect(
    labels(botItemPickedReplies(one, { text: 'Agents on the phone, Docs, changelog' }))
  ).toEqual([['Agents on the phone', 'Docs, changelog']])

  const several = botItemQuestionShape({
    ask: { questions: [{ prompt: 'Ship today?', options: [{ label: 'Yes' }] }, lead] }
  })
  const text =
    'Ship today? → Yes\nWhich changes should lead the notes? → Docs, changelog, Vault autofill'
  expect(labels(botItemPickedReplies(several, { text }))).toEqual([
    ['Yes'],
    ['Docs', 'changelog, Vault autofill']
  ])
  // Words that aren't all its options are the owner's own.
  expect(botItemPickedReplies(one, { text: 'Agents on the phone, and docs' })).toEqual([[]])
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
  // Two written: labels cleaned, no guess.
  expect(ask(['Go (Recommended)', 'Wait (Recommended)']).recommended).toBeUndefined()
  // Words it would empty, or a twin it would make, stay as written.
  expect(labelsOf(ask(['(Recommended)', 'Wait']))).toEqual(['(Recommended)', 'Wait'])
  expect(labelsOf(ask(['Go', 'Go (Recommended)']))).toEqual(['Go', 'Go (Recommended)'])
  // Recommended inside a label is its words.
  expect(labelsOf(ask(['The recommended fix']))).toEqual(['The recommended fix'])
})
