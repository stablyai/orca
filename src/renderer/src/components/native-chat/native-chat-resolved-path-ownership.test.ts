import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
describe('nativeChatAttachmentOwnerUnchanged', () => {
  it('keeps same-kind local and remote owners', () => {
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'local' }, { kind: 'local' })).toBe(true)
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'remote' }, { kind: 'remote' })).toBe(true)
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'local' }, { kind: 'remote' })).toBe(false)
  })

  it('never treats an unknown owner as the same owner', () => {
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'not-ready' }, { kind: 'not-ready' })).toBe(
      false
    )
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'local' }, { kind: 'not-ready' })).toBe(false)
  })
})
