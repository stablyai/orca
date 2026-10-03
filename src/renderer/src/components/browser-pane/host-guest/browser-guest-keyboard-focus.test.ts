// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { focusBrowserGuestForKeyboard } from './browser-guest-keyboard-focus'

function appendWebview(webContentsId: number): HTMLElement {
  const webview = document.createElement('webview')
  webview.tabIndex = 0
  Object.assign(webview, { getWebContentsId: () => webContentsId })
  document.body.append(webview)
  return webview
}

describe('focusBrowserGuestForKeyboard', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('focuses the webview hosting the guest', () => {
    appendWebview(7)
    const target = appendWebview(8)

    expect(focusBrowserGuestForKeyboard(document, 8)).toBe(true)
    expect(document.activeElement).toBe(target)
  })

  it('reports false when no webview hosts the guest', () => {
    appendWebview(7)

    expect(focusBrowserGuestForKeyboard(document, 8)).toBe(false)
  })

  it('reports false when the webview cannot take focus', () => {
    const webview = appendWebview(8)
    webview.focus = () => {}

    expect(focusBrowserGuestForKeyboard(document, 8)).toBe(false)
  })
})
