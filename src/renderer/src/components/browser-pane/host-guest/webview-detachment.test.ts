// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

const breadcrumb = vi.hoisted(() => vi.fn())
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: breadcrumb }))

import { detachBrowserWebview } from './webview-detachment'

describe('webview detachment', () => {
  it('handles only the exact guest already destroyed during Electron disconnect', () => {
    const webview = document.createElement('webview') as Electron.WebviewTag
    webview.getWebContentsId = () => 7
    const error = new Error('Invalid guestInstanceId: 7')
    error.stack = 'Error: Invalid guestInstanceId: 7\n at WebViewElement.disconnectedCallback'
    const event = new ErrorEvent('error', {
      message: `Uncaught Error: ${error.message}`,
      error,
      cancelable: true
    })
    webview.remove = () => {
      window.dispatchEvent(event)
    }
    detachBrowserWebview(webview)
    expect(event.defaultPrevented).toBe(true)
    expect(breadcrumb).toHaveBeenCalledWith('browser_guest_already_destroyed_on_detach', {
      guestId: 7
    })
    const later = new ErrorEvent('error', { message: event.message, error, cancelable: true })
    window.dispatchEvent(later)
    expect(later.defaultPrevented).toBe(false)
  })

  it.each([
    ['Invalid guestInstanceId: 8', 'WebViewElement.disconnectedCallback'],
    ['Invalid guestInstanceId: 7', 'unrelatedCallback'],
    ['Unexpected teardown failure', 'WebViewElement.disconnectedCallback']
  ])('preserves unrelated errors: %s at %s', (message, stack) => {
    const webview = document.createElement('webview') as Electron.WebviewTag
    webview.getWebContentsId = () => 7
    const error = new Error(message)
    error.stack = stack
    const event = new ErrorEvent('error', {
      message: `Uncaught Error: ${message}`,
      error,
      cancelable: true
    })
    webview.remove = () => {
      window.dispatchEvent(event)
    }
    detachBrowserWebview(webview)
    expect(event.defaultPrevented).toBe(false)
  })
})
