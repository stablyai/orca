// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useNativeChatComposerNotice } from './use-native-chat-composer-notice'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

const CHAT_ERROR: NativeChatComposerNotice = {
  key: 'composer-error',
  kind: 'error',
  text: 'sonnet-9 is not an available model for this chat session.'
}

describe('useNativeChatComposerNotice', () => {
  it("adds the composer's own notice after the chat's, each under its own key", () => {
    const chatNotices = [CHAT_ERROR]
    const { result } = renderHook(() => useNativeChatComposerNotice(chatNotices))
    act(() => result.current.setNotice('Paste failed.', 'sftp down'))
    expect(result.current.notices.map((notice) => notice.key)).toEqual([
      'composer-error',
      'composer-attachment'
    ])
    expect(result.current.notices[1]).toMatchObject({
      text: 'Paste failed.',
      errorText: 'sftp down'
    })
  })

  it("clears its own notice on dismiss and leaves the chat's", () => {
    const chatNotices = [CHAT_ERROR]
    const { result } = renderHook(() => useNativeChatComposerNotice(chatNotices))
    act(() => result.current.setNotice('Worktree not ready.'))
    act(() => result.current.notices[1]?.onDismiss?.())
    expect(result.current.notices).toEqual([CHAT_ERROR])
  })
})
