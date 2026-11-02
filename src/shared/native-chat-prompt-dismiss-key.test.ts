import { describe, expect, it } from 'vitest'
import { nativeChatCardDismissKey } from './native-chat-prompt-dismiss-key'
import type { AskQuestion } from './native-chat/input/native-chat-ask-types'

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

  it('distinguishes approvals that share a title but describe different dialogs', () => {
    const card = (description: string, send: string) =>
      nativeChatCardDismissKey({
        kind: 'approval',
        approval: {
          title: 'Claude is waiting for a choice in the terminal',
          description,
          options: [{ label: 'Yes', send }]
        }
      })

    expect(card('New MCP server found', '\r')).not.toBe(card('Detected a custom API key', '\r'))
    // A re-aimed card is the same occurrence, so an answered one stays dismissed.
    expect(card('New MCP server found', '\r')).toBe(card('New MCP server found', '\x1b[A\r'))
  })

  it('includes full normalized async content when the contributing rows are unchanged', () => {
    const text = 'x'.repeat(210)
    const first = {
      question: `${text}A`,
      header: `${text}A`,
      multiSelect: false,
      options: [{ label: 'One', description: `${text}A` }, { label: 'Two' }]
    }
    const second = { question: 'Second?', multiSelect: false, options: [] }
    const key = (questions: AskQuestion[]) =>
      nativeChatCardDismissKey({
        kind: 'question',
        prompt: { questions, replyAsMessage: true, occurrenceIds: ['addressed-call'] }
      })
    const original = key([first, second])
    for (const changed of [
      { ...first, question: `${text}B` },
      { ...first, header: `${text}B` },
      { ...first, multiSelect: true },
      { ...first, options: [{ label: 'Changed', description: `${text}A` }, { label: 'Two' }] },
      { ...first, options: [{ label: 'One', description: `${text}B` }, { label: 'Two' }] },
      { ...first, options: first.options.toReversed() }
    ]) {
      expect(key([changed, second])).not.toBe(original)
    }
    expect(key([second, first])).not.toBe(original)
  })
})
