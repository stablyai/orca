import { describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import {
  getBrowserPageRuntimeEnvironmentId,
  retryBrowserTabLoad,
  toDisplayUrl
} from './browser-page-url-display'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'

describe('browser page URL display', () => {
  it('shows a blank tab as an empty bar and redacts Kagi session tokens', () => {
    expect(toDisplayUrl(ORCA_BROWSER_BLANK_URL)).toBe('')
    expect(toDisplayUrl('about:blank')).toBe('')
    expect(toDisplayUrl('https://kagi.com/search?q=a&token=secret')).not.toContain('secret')
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
})
