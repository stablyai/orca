import { renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import {
  useNativeChatQueuedEditLifetime,
  type NativeChatQueuedEditSession
} from './native-chat-queued-edit-session'
import {
  discardNativeChatQueuedEdit,
  type NativeChatQueuedEditDraft
} from './native-chat-queued-edit-draft'

export function mountNativeChatQueuedEditLifetime(draft: NativeChatQueuedEditDraft, scope: string) {
  const edit: NativeChatQueuedEditSession = {
    ...draft,
    scope,
    sessionId: 'rich-return',
    messageId: 'queued',
    baseFingerprint: 'original',
    acquiring: false,
    uncertain: false,
    closed: false,
    pendingClose: false,
    view: { messages: [], cards: [], submissions: [], promptOpen: false },
    lease: { acquired: Promise.resolve({ status: 'released' }), end: vi.fn() }
  }
  const active: { current: NativeChatQueuedEditSession | null } = { current: edit }
  const reopen = { current: null }
  const close = vi.fn((value?: NativeChatQueuedEditSession | null) => {
    if (value) {
      discardNativeChatQueuedEdit(value)
    }
  })
  const lifetime = renderHook(() =>
    useNativeChatQueuedEditLifetime({
      scope,
      shownScope: draft.scopeKey,
      active,
      reopen,
      close,
      render: vi.fn()
    })
  )
  return { lifetime, edit, close, active }
}
