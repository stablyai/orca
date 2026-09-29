// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_PASTE_REQUEST_EVENT,
  requestNativeChatOverlayPaste
} from './native-chat-paste-request'

function paneWithChat(): { pane: HTMLDivElement; root: HTMLDivElement } {
  const pane = document.createElement('div')
  const root = document.createElement('div')
  root.dataset.nativeChatRoot = 'true'
  pane.append(document.createElement('textarea'), root)
  return { pane, root }
}

describe('requestNativeChatOverlayPaste', () => {
  it('leaves the paste to the terminal when no chat overlays the pane', () => {
    expect(requestNativeChatOverlayPaste(document.createElement('div'))).toBe(false)
  })

  it('reports whether the chat over the pane took the paste', () => {
    const { pane, root } = paneWithChat()
    expect(requestNativeChatOverlayPaste(pane)).toBe(false)
    const onRequest = vi.fn((event: Event) => event.preventDefault())
    root.addEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, onRequest)
    expect(requestNativeChatOverlayPaste(pane)).toBe(true)
    expect(onRequest).toHaveBeenCalledTimes(1)
  })
})
