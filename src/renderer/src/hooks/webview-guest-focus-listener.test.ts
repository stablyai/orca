// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { addWebviewGuestFocusListener } from './webview-guest-focus-listener'

describe('addWebviewGuestFocusListener', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function mountWebview(): HTMLElement {
    const webview = document.createElement('webview')
    document.body.append(webview)
    return webview
  }

  it('fires when focus lands on a webview guest', () => {
    const onGuestFocus = vi.fn()
    const stop = addWebviewGuestFocusListener(onGuestFocus)

    mountWebview().dispatchEvent(new Event('focusin', { bubbles: true }))

    expect(onGuestFocus).toHaveBeenCalledTimes(1)
    stop()
  })

  it('fires for focus inside a webview guest', () => {
    const onGuestFocus = vi.fn()
    const stop = addWebviewGuestFocusListener(onGuestFocus)
    const inner = document.createElement('div')
    mountWebview().append(inner)

    inner.dispatchEvent(new Event('focusin', { bubbles: true }))

    expect(onGuestFocus).toHaveBeenCalledTimes(1)
    stop()
  })

  it('ignores focus outside a webview guest', () => {
    const onGuestFocus = vi.fn()
    const stop = addWebviewGuestFocusListener(onGuestFocus)
    const sibling = document.createElement('button')
    document.body.append(sibling)
    mountWebview()

    sibling.dispatchEvent(new Event('focusin', { bubbles: true }))

    expect(onGuestFocus).not.toHaveBeenCalled()
    stop()
  })

  it('still fires when the guest stops propagation', () => {
    const onGuestFocus = vi.fn()
    const stop = addWebviewGuestFocusListener(onGuestFocus)
    const webview = mountWebview()
    webview.addEventListener('focusin', (event) => event.stopPropagation())

    webview.dispatchEvent(new Event('focusin', { bubbles: true }))

    expect(onGuestFocus).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops listening once unsubscribed', () => {
    const onGuestFocus = vi.fn()
    const stop = addWebviewGuestFocusListener(onGuestFocus)
    const webview = mountWebview()

    stop()
    webview.dispatchEvent(new Event('focusin', { bubbles: true }))

    expect(onGuestFocus).not.toHaveBeenCalled()
  })
})
