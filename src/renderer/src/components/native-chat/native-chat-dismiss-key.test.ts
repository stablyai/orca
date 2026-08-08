import { describe, expect, it } from 'vitest'
import { nativeChatCardDismissKey } from './native-chat-dismiss-key'

describe('nativeChatCardDismissKey', () => {
  it('returns null for no card', () => {
    expect(nativeChatCardDismissKey(null)).toBeNull()
  })

  it('keys a question by its full canonical content', () => {
    const key = nativeChatCardDismissKey({
      kind: 'question',
      prompt: {
        questions: [
          { question: 'Pick a color', multiSelect: false, options: [{ label: 'Red' }] },
          { question: 'Pick a size', multiSelect: false, options: [{ label: 'L' }] }
        ]
      }
    })
    expect(key).toContain('Pick a color')
    expect(key).toContain('Pick a size')
  })

  it('gives identical questions the same key (so a lingering re-emit stays hidden)', () => {
    const make = (): ReturnType<typeof nativeChatCardDismissKey> =>
      nativeChatCardDismissKey({
        kind: 'question',
        prompt: { questions: [{ question: 'Continue?', multiSelect: false, options: [] }] }
      })
    expect(make()).toBe(make())
  })

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
