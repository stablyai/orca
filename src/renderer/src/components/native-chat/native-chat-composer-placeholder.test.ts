import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))

import { nativeChatComposerPlaceholder } from './native-chat-composer-target'

describe("the composer's placeholder", () => {
  it('says a message runs after the stop while the chat reads Stopping', () => {
    expect(nativeChatComposerPlaceholder(true, true, 'queue')).toBe(
      'Queue a message to run after the stop'
    )
    // Where the host does not queue sends, it holds the message until the stop lands.
    expect(nativeChatComposerPlaceholder(true, true, 'send')).toBe(
      'Send a message to run after the stop'
    )
  })

  it('reads as usual otherwise', () => {
    expect(nativeChatComposerPlaceholder(true, true)).toBe('Send a message…')
  })

  // A held input or a lost terminal says why first: nothing can be queued from here then.
  it('keeps the reasons nothing can be sent ahead of it', () => {
    expect(nativeChatComposerPlaceholder(true, false, 'queue')).toBe(
      'Input is held by another device.'
    )
  })
})
