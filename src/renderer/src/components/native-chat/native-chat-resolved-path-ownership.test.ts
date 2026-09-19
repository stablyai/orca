import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import type { NativeChatSshAttachmentOwner } from './native-chat-attachment-upload'

function ssh(overrides: Partial<NativeChatSshAttachmentOwner> = {}): NativeChatSshAttachmentOwner {
  return {
    kind: 'ssh',
    connectionId: 'conn-1',
    worktreePath: '/remote/wt',
    expectedExecutionHostId: 'ssh:conn-1',
    expectedSshTargetId: 'conn-1',
    expectedSshConnectionGeneration: 4,
    ...overrides
  }
}

describe('nativeChatAttachmentOwnerUnchanged', () => {
  it('keeps same-kind local and runtime owners', () => {
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'local' }, { kind: 'local' })).toBe(true)
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'runtime' }, { kind: 'runtime' })).toBe(true)
  })

  it('never treats an unknown owner as the same owner', () => {
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'not-ready' }, { kind: 'not-ready' })).toBe(
      false
    )
    expect(nativeChatAttachmentOwnerUnchanged({ kind: 'local' }, { kind: 'not-ready' })).toBe(false)
  })

  it('rejects an SSH reconnect that keeps the same connection id', () => {
    expect(nativeChatAttachmentOwnerUnchanged(ssh(), ssh())).toBe(true)
    expect(
      nativeChatAttachmentOwnerUnchanged(ssh(), ssh({ expectedSshConnectionGeneration: 5 }))
    ).toBe(false)
    expect(nativeChatAttachmentOwnerUnchanged(ssh(), ssh({ connectionId: 'conn-2' }))).toBe(false)
    expect(nativeChatAttachmentOwnerUnchanged(ssh(), ssh({ worktreePath: '/other' }))).toBe(false)
  })
})
