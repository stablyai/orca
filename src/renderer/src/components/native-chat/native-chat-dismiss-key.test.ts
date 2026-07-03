import { describe, expect, it } from 'vitest'
import { nativeChatCardDismissKey } from './native-chat-dismiss-key'

describe('nativeChatCardDismissKey', () => {
  it('returns null for no card', () => {
    expect(nativeChatCardDismissKey(null)).toBeNull()
  })

  it('keys a question by its count and first question text', () => {
    const key = nativeChatCardDismissKey({
      kind: 'question',
      prompt: {
        questions: [
          { question: 'Pick a color', multiSelect: false, options: [{ label: 'Red' }] },
          { question: 'Pick a size', multiSelect: false, options: [{ label: 'L' }] }
        ]
      }
    })
    expect(key).toBe('question:2:Pick a color')
  })

  it('gives identical questions the same key (so a lingering re-emit stays hidden)', () => {
    const make = (): ReturnType<typeof nativeChatCardDismissKey> =>
      nativeChatCardDismissKey({
        kind: 'question',
        prompt: { questions: [{ question: 'Continue?', multiSelect: false, options: [] }] }
      })
    expect(make()).toBe(make())
  })

  it('keys an approval by its title and detail', () => {
    const key = nativeChatCardDismissKey({
      kind: 'approval',
      approval: {
        title: 'Allow Bash?',
        detail: 'rm -rf build',
        options: [{ label: 'Allow', send: '1' }]
      }
    })
    expect(key).toBe('approval:Allow Bash?:rm -rf build')
  })

  it('distinguishes different approvals', () => {
    const a = nativeChatCardDismissKey({
      kind: 'approval',
      approval: { title: 'Allow Bash?', options: [] }
    })
    const b = nativeChatCardDismissKey({
      kind: 'approval',
      approval: { title: 'Allow Write?', options: [] }
    })
    expect(a).not.toBe(b)
  })
})
