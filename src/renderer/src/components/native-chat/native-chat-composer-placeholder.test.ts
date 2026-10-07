import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))

import { nativeChatComposerPlaceholder } from './native-chat-composer-target'

describe("the composer's placeholder", () => {
  // Where a send is not queued, the host holds it until the stop lands.
  it('says a message runs after the stop while the chat reads Stopping and sends are not queued', () => {
    expect(nativeChatComposerPlaceholder(true, true, 'send')).toBe(
      'Send a message to run after the stop'
    )
  })

  // A queued one is a card the Stop holds until Resume: nothing promises it runs after the stop.
  it('reads as usual while Stopping where a send is queued', () => {
    expect(nativeChatComposerPlaceholder(true, true, 'queue')).toBe('Send a message…')
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
