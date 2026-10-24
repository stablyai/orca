// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { NativeChatViewIdentity } from './native-chat-view-state-memory'
import {
  useNativeChatComposerError,
  useNativeChatComposerNotice
} from './use-native-chat-composer-notice'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

const CHAT_ERROR: NativeChatComposerNotice = {
  key: 'composer-error',
  kind: 'error',
  text: 'sonnet-9 is not an available model for this chat session.'
}

describe('useNativeChatComposerNotice', () => {
  it('keeps a rejection and an upload failure that settles while parked, then clears on the normal actions', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NativeChatViewIdentity.Provider value="notice-return">
        {children}
      </NativeChatViewIdentity.Provider>
    )
    let current = true
    const mount = () =>
      renderHook(
        () => ({
          error: useNativeChatComposerError(
            { working: false, background: false, sending: false, retry: false, prompt: false },
            current
          ),
          attachments: useNativeChatComposerNotice()
        }),
        { wrapper }
      )
    const first = mount()
    act(() =>
      first.result.current.error.reportComposerError(
        'Remove attachments before using a chat-session command.'
      )
    )
    const settleUpload = first.result.current.attachments.setNotice
    first.unmount()
    act(() => settleUpload('Could not upload the image.', 'connection lost'))
    current = false
    const returned = mount()
    expect(returned.result.current.error.composerError?.text).toBe(
      'Remove attachments before using a chat-session command.'
    )
    expect(returned.result.current.attachments.notices[0]?.text).toBe('Could not upload the image.')
    act(() => {
      returned.result.current.error.reportComposerError(null)
      returned.result.current.attachments.notices[0]?.onDismiss?.()
    })
    expect(returned.result.current.error.composerError).toBeNull()
    expect(returned.result.current.attachments.notices).toEqual([])
  })

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
