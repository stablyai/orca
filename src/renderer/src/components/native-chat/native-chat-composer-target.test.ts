// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { nativeChatComposerPlaceholder } from './native-chat-composer-target'

describe('nativeChatComposerPlaceholder', () => {
  it('reads as disconnected when there is no send route at all (legacy PTY-only pane, D1 regression)', () => {
    expect(nativeChatComposerPlaceholder(false, true)).toBe(
      'No live terminal — toggle back to reconnect.'
    )
  })

  it('is a normal send prompt for an RPC-owned pane with no PTY — never the disconnected string', () => {
    // hasSendRoute=true via RPC ownership alone (targetPtyId is null for this
    // pane by design, Decision 1): the placeholder must not claim the pane is
    // disconnected just because the PTY-specific route is absent.
    const placeholder = nativeChatComposerPlaceholder(true, true)
    expect(placeholder).not.toBe('No live terminal — toggle back to reconnect.')
    expect(placeholder).toBe('Send a message…')
  })

  it('still reports the multi-device lock when a send route exists but canSend is false', () => {
    expect(nativeChatComposerPlaceholder(true, false)).toBe('Input is held by another device.')
  })

  it('prioritizes "no route" over the multi-device lock copy', () => {
    expect(nativeChatComposerPlaceholder(false, false)).toBe(
      'No live terminal — toggle back to reconnect.'
    )
  })
})
