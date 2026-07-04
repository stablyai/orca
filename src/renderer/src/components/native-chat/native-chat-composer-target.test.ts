import { describe, expect, it, vi } from 'vitest'
import { nativeChatComposerPlaceholder } from './native-chat-composer-target'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('nativeChatComposerPlaceholder', () => {
  it('prioritizes the missing PTY state', () => {
    expect(nativeChatComposerPlaceholder(false, true, 'approval')).toBe(
      'No live terminal — toggle back to reconnect.'
    )
  })

  it('prioritizes the mobile lock state before pending prompts', () => {
    expect(nativeChatComposerPlaceholder(true, false, 'question')).toBe(
      'Input is held by another device.'
    )
  })

  it('names pending approval state when the composer can still receive focus', () => {
    expect(nativeChatComposerPlaceholder(true, true, 'approval')).toBe(
      'Resolve the approval above to continue.'
    )
  })

  it('names pending question state without implying composer text will submit it', () => {
    expect(nativeChatComposerPlaceholder(true, true, 'question')).toBe(
      'Use the question panel above to answer.'
    )
  })

  it('uses the ready prompt when no blocking state is present', () => {
    expect(nativeChatComposerPlaceholder(true, true)).toBe('Send a message…')
  })
})
