import { describe, expect, it } from 'vitest'
import { nativeChatCardDismissKey } from './native-chat-prompt-dismiss-key'

describe('nativeChatCardDismissKey', () => {
  it('distinguishes prompts whose later questions or options changed', () => {
    const card = (second: string, option: string) =>
      nativeChatCardDismissKey({
        kind: 'question',
        prompt: {
          questions: [
            { question: 'Same first', multiSelect: false, options: [] },
            { question: second, multiSelect: false, options: [{ label: option }] }
          ]
        }
      })

    expect(card('Old second', 'A')).not.toBe(card('New second', 'A'))
    expect(card('Old second', 'A')).not.toBe(card('Old second', 'B'))
  })
})
