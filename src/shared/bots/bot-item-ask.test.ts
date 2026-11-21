import { expect, it } from 'vitest'
import { botItemPickedReplies, botItemQuestionShape } from './bot-item-ask'

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
