import { expect, it } from 'vitest'
import { botItemAnswerDraftText } from './bot-item-answer-drafts'

it('keeps words typed but not chosen apart from the picked answer', () => {
  const text = botItemAnswerDraftText({
    prompt: {
      questions: [
        {
          question: 'Which environment?',
          multiSelect: false,
          options: [{ label: 'Staging' }, { label: 'Production' }]
        }
      ]
    },
    // Staging picked; the typed words were left behind when the pick replaced them.
    selections: [[0]],
    otherText: ['maybe both tomorrow']
  })

  expect(text).toBe('Which environment?\n→ Staging\n(typed, not chosen: maybe both tomorrow)')
})
