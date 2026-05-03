import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/types'

vi.mock('../../components/browser-pane/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))

import { collectBrowserWebviewIds, destroyWorkspaceWebviews } from './browser-webview-cleanup'
import { destroyPersistentWebview } from '../../components/browser-pane/webview-registry'

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
