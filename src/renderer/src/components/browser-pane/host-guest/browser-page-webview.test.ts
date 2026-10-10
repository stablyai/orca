// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { BROWSER_GUEST_WINDOW_CLOSE_CHANNEL } from '../../../../../shared/browser-guest-window-close'
import { ensureBrowserPageWebview, setBrowserPageWebviewInputLock } from './browser-page-webview'
import { unregisterPersistentWebview } from './webview-registry'

const { closeBrowserPageFromGuestMock } = vi.hoisted(() => ({
  closeBrowserPageFromGuestMock: vi.fn()
}))

vi.mock('@/lib/browser-page-guest-close', () => ({
  closeBrowserPageFromGuest: closeBrowserPageFromGuestMock
}))

describe('setBrowserPageWebviewInputLock', () => {
  it('updates an existing webview when browser control changes hands', () => {
    const webview = document.createElement('webview') as Electron.WebviewTag

    setBrowserPageWebviewInputLock(webview, true)
    expect(webview.style.pointerEvents).toBe('none')

    setBrowserPageWebviewInputLock(webview, false)
    expect(webview.style.pointerEvents).toBe('auto')
  })
})

describe('ensureBrowserPageWebview', () => {
  it("closes the page's tab when its guest calls window.close()", () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const created = ensureBrowserPageWebview({
      browserTabId: 'page-closing',
      container,
      inputLocked: false,
      webviewPartition: 'persist:orca-browser',
      resolveContainer: () => container
    })
    if (!created) {
      throw new Error('expected a webview')
    }
    const { webview } = created

    webview.dispatchEvent(Object.assign(new Event('ipc-message'), { channel: 'other-channel' }))
    expect(closeBrowserPageFromGuestMock).not.toHaveBeenCalled()

    webview.dispatchEvent(
      Object.assign(new Event('ipc-message'), { channel: BROWSER_GUEST_WINDOW_CLOSE_CHANNEL })
    )
    expect(closeBrowserPageFromGuestMock).toHaveBeenCalledWith('page-closing')

    unregisterPersistentWebview('page-closing')
    container.remove()
  })
})
