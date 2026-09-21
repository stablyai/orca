import { describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import {
  getBrowserDisplayTitle,
  getBrowserPageRuntimeEnvironmentId,
  getNotebookPathFromBrowserUrl,
  getOpenableExternalUrl,
  isChromiumErrorPage,
  retryBrowserTabLoad,
  toDisplayUrl
} from './browser-page-url-display'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'

describe('browser page URL display', () => {
  it('maps the blank-tab sentinel to about:blank and redacts Kagi session tokens', () => {
    expect(toDisplayUrl(ORCA_BROWSER_BLANK_URL)).toBe('about:blank')
    expect(toDisplayUrl('https://kagi.com/search?q=a&token=secret')).not.toContain('secret')
  })

  it('titles blank tabs New Tab and otherwise uses the provided title', () => {
    expect(getBrowserDisplayTitle('Example', 'https://example.com')).toBe('Example')
    expect(getBrowserDisplayTitle(null, 'about:blank')).toBe('New Tab')
    expect(getBrowserDisplayTitle('about:blank', 'https://example.com')).toBe('New Tab')
    expect(getBrowserDisplayTitle('Example', ORCA_BROWSER_BLANK_URL)).toBe('New Tab')
  })

  it('detects Chromium error pages', () => {
    expect(isChromiumErrorPage('chrome-error://chromewebdata/')).toBe(true)
    expect(isChromiumErrorPage('https://example.com')).toBe(false)
  })

  it('extracts notebook paths only from file URLs ending in .ipynb', () => {
    expect(getNotebookPathFromBrowserUrl('https://example.com/notebook.ipynb')).toBeNull()
  })

  it('prefers the page-owned runtime environment id when present', () => {
    expect(
      getBrowserPageRuntimeEnvironmentId(
        { browserRuntimeEnvironmentId: ' env-1 ' } as BrowserPageState,
        'inferred'
      )
    ).toBe('env-1')
    expect(
      getBrowserPageRuntimeEnvironmentId(
        { browserRuntimeEnvironmentId: undefined } as BrowserPageState,
        ' inferred '
      )
    ).toBe('inferred')
    expect(
      getBrowserPageRuntimeEnvironmentId(
        { browserRuntimeEnvironmentId: '   ' } as BrowserPageState,
        'inferred'
      )
    ).toBeNull()
  })

  it('opens only normalizable external URLs', () => {
    expect(getOpenableExternalUrl('https://example.com')).toBe('https://example.com/')
    expect(getOpenableExternalUrl(ORCA_BROWSER_BLANK_URL)).toBeNull()
  })

  it('retries a failed load by assigning the attempted URL instead of reload()', () => {
    const webview = { src: 'chrome-error://chromewebdata/' }
    const onUpdatePageState = vi.fn()
    retryBrowserTabLoad(
      webview as Electron.WebviewTag,
      {
        id: 'page-1',
        url: 'https://example.com/app',
        loadError: { code: -102, description: 'refused', validatedUrl: 'https://example.com/app' }
      } as BrowserPageState,
      onUpdatePageState
    )
    expect(onUpdatePageState).toHaveBeenCalledWith('page-1', {
      loading: true,
      title: 'https://example.com/app'
    })
    expect(webview.src).toBe('https://example.com/app')
  })

  it('does nothing when there is no webview', () => {
    const onUpdatePageState = vi.fn()
    retryBrowserTabLoad(
      null,
      { id: 'page-1', url: 'https://example.com' } as BrowserPageState,
      onUpdatePageState
    )
    expect(onUpdatePageState).not.toHaveBeenCalled()
  })
})
