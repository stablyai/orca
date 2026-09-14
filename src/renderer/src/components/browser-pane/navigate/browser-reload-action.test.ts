import { describe, expect, it, vi } from 'vitest'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'
import {
  reloadBrowserPageWebview,
  resolveBrowserReloadButtonLabelKind,
  resolveBrowserReloadIntent
} from './browser-reload-action'

const idle = { loading: false, loadErrorCode: null }
const loading = { loading: true, loadErrorCode: null }
const failed = { loading: false, loadErrorCode: -105 }
const guestFailed = { loading: false, loadErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE }

describe('resolveBrowserReloadIntent', () => {
  it('reloads an idle page from every trigger', () => {
    expect(resolveBrowserReloadIntent('button', idle)).toBe('reload')
    expect(resolveBrowserReloadIntent('reload', idle)).toBe('reload')
    expect(resolveBrowserReloadIntent('hard-reload', idle)).toBe('hard-reload')
  })

  it('stops an in-flight load only from the toolbar button', () => {
    expect(resolveBrowserReloadIntent('button', loading)).toBe('stop')
    expect(resolveBrowserReloadIntent('reload', loading)).toBe('reload')
    expect(resolveBrowserReloadIntent('hard-reload', loading)).toBe('hard-reload')
  })

  // Why: reload() on chrome-error:// only refreshes the error page — every entry point must retry the load.
  it('routes a failed load to the retry path from the menu too', () => {
    expect(resolveBrowserReloadIntent('button', failed)).toBe('retry-load')
    expect(resolveBrowserReloadIntent('reload', failed)).toBe('retry-load')
    expect(resolveBrowserReloadIntent('hard-reload', failed)).toBe('retry-load')
  })

  it('routes a guest-recovery failure to guest recovery from the menu too', () => {
    expect(resolveBrowserReloadIntent('button', guestFailed)).toBe('retry-guest-recovery')
    expect(resolveBrowserReloadIntent('reload', guestFailed)).toBe('retry-guest-recovery')
    expect(resolveBrowserReloadIntent('hard-reload', guestFailed)).toBe('retry-guest-recovery')
  })

  it('prefers stop over retry when a failed page is already reloading', () => {
    expect(resolveBrowserReloadIntent('button', { loading: true, loadErrorCode: -105 })).toBe(
      'stop'
    )
  })
})

describe('resolveBrowserReloadButtonLabelKind', () => {
  it('names the button for what it actually does', () => {
    expect(resolveBrowserReloadButtonLabelKind(idle)).toBe('reload')
    expect(resolveBrowserReloadButtonLabelKind(loading)).toBe('stop')
    expect(resolveBrowserReloadButtonLabelKind(failed)).toBe('retry')
    expect(resolveBrowserReloadButtonLabelKind(guestFailed)).toBe('retry')
  })
})

describe('reloadBrowserPageWebview', () => {
  function createWebview(overrides: Partial<Electron.WebviewTag> = {}): Electron.WebviewTag {
    return {
      getWebContentsId: vi.fn(() => 42),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      ...overrides
    } as unknown as Electron.WebviewTag
  }

  it('reloads a live guest, honoring the cache flag', () => {
    const webview = createWebview()
    expect(reloadBrowserPageWebview(webview, { ignoreCache: false })).toBe('reloaded')
    expect(webview.reload).toHaveBeenCalledTimes(1)

    expect(reloadBrowserPageWebview(webview, { ignoreCache: true })).toBe('reloaded')
    expect(webview.reloadIgnoringCache).toHaveBeenCalledTimes(1)
  })

  // Why: a destroyed guest makes reload() throw uncaught (STA-3448) — callers must recreate the guest instead.
  it('reports a missing guest without touching reload', () => {
    const webview = createWebview({
      getWebContentsId: vi.fn(() => {
        throw new Error('WebContents is destroyed')
      })
    })
    expect(reloadBrowserPageWebview(webview, { ignoreCache: false })).toBe('guest-missing')
    expect(webview.reload).not.toHaveBeenCalled()
  })

  it('reports a guest destroyed between the liveness probe and reload', () => {
    const getWebContentsId = vi
      .fn<() => number>()
      .mockReturnValueOnce(42)
      .mockImplementation(() => {
        throw new Error('WebContents is destroyed')
      })
    const webview = createWebview({
      getWebContentsId,
      reload: vi.fn(() => {
        throw new Error('The WebView must be attached to the DOM')
      })
    })

    expect(reloadBrowserPageWebview(webview, { ignoreCache: false })).toBe('guest-missing')
    expect(getWebContentsId).toHaveBeenCalledTimes(2)
  })

  // Why: pre-dom-ready reload throws too, but a live guest is already loading — recovery must not replace it.
  it('reports not-ready when a live guest rejects the reload', () => {
    const webview = createWebview({
      reload: vi.fn(() => {
        throw new Error('The WebView must be attached to the DOM')
      })
    })
    expect(reloadBrowserPageWebview(webview, { ignoreCache: false })).toBe('not-ready')
  })
})
