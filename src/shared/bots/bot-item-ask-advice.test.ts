import { describe, expect, it } from 'vitest'
import { botItemAskAdvice, botItemAskAdviceWithout } from './bot-item-ask-advice'

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
})

describe('botItemAskAdviceWithout', () => {
  const context = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the background.`).join('\n')

  it('drops the long-context tip and shows the next one in its place', () => {
    const long = botItemAskAdvice({
      ask: { context, questions: [{ prompt: 'Merge it?', options }] }
    })
    expect(long?.codes).toEqual(['long_context'])
    expect(botItemAskAdviceWithout(long!, 'long_context')).toBeNull()

    const withJargon = botItemAskAdvice({
      ask: { context, questions: [{ prompt: 'Merge 3f9a2c7d1e4b5a6c?', options }] }
    })!
    const kept = botItemAskAdviceWithout(withJargon, 'long_context')
    expect(kept?.codes).toEqual(['jargon'])
    expect(kept?.tip).toContain('hash or ID')
  })
})
