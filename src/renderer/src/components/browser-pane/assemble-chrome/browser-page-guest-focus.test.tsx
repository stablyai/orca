// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWebviewGuestFocus } from './browser-page-guest-focus'

describe('useWebviewGuestFocus', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('does not expose a bare webview element as an attached guest', () => {
    const getWebContentsId = vi.fn<() => number>(() => {
      throw new Error('guest not attached')
    })
    const webview = { getWebContentsId } as unknown as Electron.WebviewTag
    const webviewRef = { current: webview }
    const { result } = renderHook(() => useWebviewGuestFocus(webviewRef))

    expect(result.current.isAttached()).toBe(false)

    getWebContentsId.mockReturnValue(42)
    expect(result.current.isAttached()).toBe(true)
  })

  it('focuses the embedder before handing keyboard focus to the guest', () => {
    const focusWindow = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const webview = document.createElement('div') as unknown as Electron.WebviewTag
    webview.tabIndex = -1
    document.body.appendChild(webview)
    const focusWebview = vi.spyOn(webview, 'focus')

    const { result } = renderHook(() => useWebviewGuestFocus({ current: webview }))

    expect(result.current.focus()).toBe(true)
    expect(document.activeElement).toBe(webview)
    expect(focusWindow.mock.invocationCallOrder[0]).toBeLessThan(
      focusWebview.mock.invocationCallOrder[0]
    )
    webview.remove()
  })
})
