// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { requestNativeChatOverlayPaste } from '@/lib/native-chat-paste-request'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'

function mountChatOverPane(composer: Partial<NativeChatComposerHandle> | null) {
  const pane = document.createElement('div')
  const root = document.createElement('div')
  root.dataset.nativeChatRoot = 'true'
  pane.append(root)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge only calls pasteFromClipboard/handlePasteEvent, both stubbed here.
  const composerRef = { current: composer as NativeChatComposerHandle | null }
  renderHook(() => useNativeChatPasteBridge({ rootRef: { current: root }, composerRef }))
  return pane
}

describe('useNativeChatPasteBridge paste requests', () => {
  it('pastes into the composer when the terminal under the chat hands it a paste', () => {
    const pasteFromClipboard = vi.fn()
    const pane = mountChatOverPane({ pasteFromClipboard, handlePasteEvent: vi.fn() })
    expect(requestNativeChatOverlayPaste(pane)).toBe(true)
    expect(pasteFromClipboard).toHaveBeenCalledTimes(1)
  })

  it('declines while no chat input is mounted', () => {
    const pane = mountChatOverPane(null)
    expect(requestNativeChatOverlayPaste(pane)).toBe(false)
  })
})
