// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { setBrowserPageWebviewInputLock } from './browser-page-webview'

describe('setBrowserPageWebviewInputLock', () => {
  it('updates an existing webview when browser control changes hands', () => {
    const webview = document.createElement('webview') as Electron.WebviewTag

    setBrowserPageWebviewInputLock(webview, true)
    expect(webview.style.pointerEvents).toBe('none')

    setBrowserPageWebviewInputLock(webview, false)
    expect(webview.style.pointerEvents).toBe('auto')
  })
})
