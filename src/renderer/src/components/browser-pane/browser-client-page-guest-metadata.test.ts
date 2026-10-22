import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ recordBreadcrumb: vi.fn() }))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordBreadcrumb
}))

import { removeBrowserClientPageWebview } from './browser-client-page-guest-metadata'

// Why a synthetic throw rather than a real dead guest: this pins the helper's own try/catch
// contract (any synchronous throw out of `.remove()` is swallowed and breadcrumbed), not that
// Electron's `Invalid guestInstanceId` actually reaches this call site — see the module doc's
// note that Blink may report that specific exception globally instead of rethrowing it here.
function throwingWebview(error: Error): Pick<Electron.WebviewTag, 'remove'> {
  return {
    remove: vi.fn(() => {
      throw error
    })
  }
}

describe('removeBrowserClientPageWebview', () => {
  it('removes a live webview without recording a breadcrumb', () => {
    const webview: Pick<Electron.WebviewTag, 'remove'> = { remove: vi.fn() }

    removeBrowserClientPageWebview(webview)

    expect(webview.remove).toHaveBeenCalledOnce()
    expect(mocks.recordBreadcrumb).not.toHaveBeenCalled()
  })

  it('swallows a synchronous throw from .remove() instead of propagating it', () => {
    const webview = throwingWebview(new Error('Invalid guestInstanceId: 7'))

    expect(() => removeBrowserClientPageWebview(webview)).not.toThrow()
    expect(mocks.recordBreadcrumb).toHaveBeenCalledWith(
      'browser_client_page_webview_removal_failed',
      expect.objectContaining({ errorMessage: 'Invalid guestInstanceId: 7' })
    )
  })
})
