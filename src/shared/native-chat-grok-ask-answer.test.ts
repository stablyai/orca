import { describe, expect, it } from 'vitest'
import { buildGrokAskAnswerKeys } from './native-chat-grok-ask-answer'

const CAPTURED_GROK_1_0_5_INTERACTION = {
  prompt: {
    questions: [
      {
        question: 'Color',
        multiSelect: false,
        options: [{ label: 'Red' }, { label: 'Blue' }]
      },
      {
        question: 'Features',
        multiSelect: true,
        options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Metrics' }]
      },
      {
        question: 'Deploy',
        multiSelect: false,
        options: [{ label: 'Now' }, { label: 'Later' }]
      }
    ]
  },
  selections: [{ indices: [1] }, { indices: [0, 2] }, { indices: [0] }],
  keys: [
    { raw: '2' },
    { raw: ' ' },
    { raw: '\x1b[B' },
    { raw: '\x1b[B' },
    { raw: ' ' },
    { raw: '\r' },
    { raw: '1' }
  ]
}

describe('buildGrokAskAnswerKeys', () => {
  it('matches a captured three-question Grok interaction', () => {
    expect(
      buildGrokAskAnswerKeys(
        CAPTURED_GROK_1_0_5_INTERACTION.prompt,
        CAPTURED_GROK_1_0_5_INTERACTION.selections
      )
    ).toEqual(CAPTURED_GROK_1_0_5_INTERACTION.keys)
  })
})
