import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/types'

vi.mock('../../components/browser-pane/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))

import {
  collectBrowserWebviewIds,
  destroyRemovedBrowserWebview,
  destroyWorkspaceWebviews,
  destroyWorktreeBrowserGuests
} from './browser-webview-cleanup'
import { destroyPersistentWebview } from '../../components/browser-pane/webview-registry'
import {
  forgetExplicitBrowserPageZoomLevel,
  getExplicitBrowserPageZoomLevel,
  rememberExplicitBrowserPageZoomLevel
} from '../../components/browser-pane/browser-page-zoom'

function workspace(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: 'wt-1',
    label: id,
    sessionProfileId: null,
    pageIds: [],
    activePageId: null,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function page(id: string, workspaceId: string): BrowserPage {
  return {
    id,
    workspaceId,
    worktreeId: 'wt-1',
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

describe('collectBrowserWebviewIds', () => {
  it('tracks browser page ids because webviews are keyed by page id', () => {
    const ids = collectBrowserWebviewIds(
      { 'wt-1': [workspace('workspace-1')] },
      { 'workspace-1': [page('page-1', 'workspace-1'), page('page-2', 'workspace-1')] }
    )

    expect([...ids].sort()).toEqual(['page-1', 'page-2'])
  })

  it('keeps legacy workspace ids only when no page records exist', () => {
    const ids = collectBrowserWebviewIds({ 'wt-1': [workspace('legacy-workspace')] }, {})

    expect([...ids]).toEqual(['legacy-workspace'])
  })
})

describe('destroyWorkspaceWebviews', () => {
  beforeEach(() => {
    vi.mocked(destroyPersistentWebview).mockClear()
  })

  it('destroys the webview when the backing page is removed', () => {
    destroyRemovedBrowserWebview('page-1')

    expect(destroyPersistentWebview).toHaveBeenCalledWith('page-1')
  })

  it('destroys every page id for a multi-page workspace', () => {
    destroyWorkspaceWebviews(
      { 'workspace-1': [page('page-1', 'workspace-1'), page('page-2', 'workspace-1')] },
      'workspace-1'
    )

    expect(destroyPersistentWebview).toHaveBeenCalledTimes(2)
    expect(destroyPersistentWebview).toHaveBeenCalledWith('page-1')
    expect(destroyPersistentWebview).toHaveBeenCalledWith('page-2')
  })

  it('falls back to the workspace id when no pages exist (legacy sessions)', () => {
    destroyWorkspaceWebviews({}, 'legacy-workspace')

    expect(destroyPersistentWebview).toHaveBeenCalledTimes(1)
    expect(destroyPersistentWebview).toHaveBeenCalledWith('legacy-workspace')
  })

  it('falls back to the workspace id when the workspace key is present but empty', () => {
    destroyWorkspaceWebviews({ 'workspace-1': [] }, 'workspace-1')

    expect(destroyPersistentWebview).toHaveBeenCalledTimes(1)
    expect(destroyPersistentWebview).toHaveBeenCalledWith('workspace-1')
  })
})

describe('destroyWorktreeBrowserGuests', () => {
  beforeEach(() => {
    vi.mocked(destroyPersistentWebview).mockClear()
  })

  it('destroys every guest across all of one worktree tabs, leaving other worktrees alone', () => {
    destroyWorktreeBrowserGuests(
      {
        'wt-1': [workspace('workspace-1'), workspace('legacy-workspace')],
        'wt-2': [workspace('workspace-2')]
      },
      {
        'workspace-1': [page('page-1', 'workspace-1'), page('page-2', 'workspace-1')],
        'workspace-2': [page('page-3', 'workspace-2')]
      },
      'wt-1'
    )

    expect(destroyPersistentWebview).toHaveBeenCalledTimes(3)
    expect(destroyPersistentWebview).toHaveBeenCalledWith('page-1')
    expect(destroyPersistentWebview).toHaveBeenCalledWith('page-2')
    // Legacy tabs without page records key their webview by the tab id.
    expect(destroyPersistentWebview).toHaveBeenCalledWith('legacy-workspace')
    expect(destroyPersistentWebview).not.toHaveBeenCalledWith('page-3')
  })

  it('is a no-op for a worktree without browser tabs', () => {
    destroyWorktreeBrowserGuests({}, {}, 'wt-1')

    expect(destroyPersistentWebview).not.toHaveBeenCalled()
  })

  it('re-remembers explicit zoom past the destroy-path forget (eviction is not a close)', () => {
    // Mirror the real registry contract: a plain destroy forgets explicit zoom.
    vi.mocked(destroyPersistentWebview).mockImplementation((browserTabId: string) => {
      forgetExplicitBrowserPageZoomLevel(browserTabId)
      return Promise.resolve()
    })
    rememberExplicitBrowserPageZoomLevel('page-1', 1.5)
    rememberExplicitBrowserPageZoomLevel('legacy-workspace', 0.5)

    destroyWorktreeBrowserGuests(
      { 'wt-1': [workspace('workspace-1'), workspace('legacy-workspace')] },
      { 'workspace-1': [page('page-1', 'workspace-1'), page('page-2', 'workspace-1')] },
      'wt-1'
    )

    expect(getExplicitBrowserPageZoomLevel('page-1')).toBe(1.5)
    expect(getExplicitBrowserPageZoomLevel('legacy-workspace')).toBe(0.5)
    // A page the user never zoomed stays unremembered.
    expect(getExplicitBrowserPageZoomLevel('page-2')).toBeNull()

    forgetExplicitBrowserPageZoomLevel('page-1')
    forgetExplicitBrowserPageZoomLevel('legacy-workspace')
    vi.mocked(destroyPersistentWebview).mockReset()
  })
})
