import { describe, expect, it } from 'vitest'
import { buildPersistedBrowserPagesByWorkspace } from './workspace-session-browser-tabs'
import type { BrowserPage } from '../../../../../shared/browser/workspaces/browser-workspace-types'

const savedPage: BrowserPage = {
  id: 'p1',
  workspaceId: 'w1',
  worktreeId: 'wt',
  url: 'https://example.com/',
  title: '',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 0,
  browserRuntimeEnvironmentId: 'env-1',
  remoteBrowserPageId: 'p1',
  remoteBrowserPageClientHosted: true,
  remoteBrowserPagePlacedHere: true
}

describe('buildPersistedBrowserPagesByWorkspace', () => {
  it('saves placed-here only while the live handle still carries it', () => {
    const save = (placedHere: boolean) =>
      buildPersistedBrowserPagesByWorkspace(
        { w1: [savedPage] },
        {
          p1: {
            environmentId: 'env-1',
            remotePageId: 'p1',
            restoredClientHosted: true,
            ...(placedHere ? { placedHere: true as const } : {})
          }
        },
        {}
      )?.['w1']?.[0]?.remoteBrowserPagePlacedHere
    expect(save(true)).toBe(true)
    expect(save(false)).toBeUndefined()
  })
})
