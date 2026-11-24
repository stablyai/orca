import { describe, expect, it } from 'vitest'
import { botItemAskAdvice } from './bot-item-ask-advice'

const options = [{ label: 'Merge now' }, { label: 'Wait for Monday' }]

describe('botItemAskAdvice', () => {
  it('reads choices named in the context as the buttons once every question has options', () => {
    const context = 'Two ways: A) merge now, B) wait. Option B is safer (recommended).'
    const ask = {
      context,
      questions: [
        { prompt: 'Merge without the review?', options, recommended: 1 },
        { prompt: 'Tag the release now?', options: [{ label: 'Yes' }, { label: 'No' }] }
      ]
    }
    expect(botItemAskAdvice({ ask })).toBeNull()
    // A question left without options still gets the tip.
    const bare = { context, questions: [{ prompt: 'Merge without the review?', options: [] }] }
    expect(botItemAskAdvice({ ask: bare })?.codes).toContain('prose_choices')
  })

  it('takes long context as written: it may come from --comment-file', () => {
    const context = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of the background.`).join(
      '\n'
    )
    expect(
      botItemAskAdvice({ ask: { context, questions: [{ prompt: 'Merge it?', options }] } })
    ).toBeNull()
  })
})
