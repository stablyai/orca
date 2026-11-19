import { describe, expect, it } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/browser/browser-blank-page'
import { getBrowserDisplayTitle } from '../../../../../shared/browser/browser-display-title'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { getBrowserTabLabel } from './browser-tab-label'

const czech = (_key: string, fallback: string): string =>
  fallback === 'New Tab' ? 'Nová karta' : fallback

function tab(url: string, title: string): BrowserWorkspace {
  return {
    id: 'tab',
    worktreeId: 'wt',
    url,
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

describe('getBrowserTabLabel', () => {
  it.each([ORCA_BROWSER_BLANK_URL, 'about:blank'])(
    'localizes the stored blank-page title for %s',
    (url) => {
      expect(getBrowserTabLabel(tab(url, getBrowserDisplayTitle(null, url)), czech)).toBe(
        'Nová karta'
      )
    }
  )

  it('keeps a real page titled "New Tab"', () => {
    expect(getBrowserTabLabel(tab('https://example.com/', 'New Tab'), czech)).toBe('New Tab')
  })

  it('keeps the file name of a document preview on the blank URL', () => {
    expect(getBrowserTabLabel(tab(ORCA_BROWSER_BLANK_URL, 'README.md'), czech)).toBe('README.md')
  })
})
