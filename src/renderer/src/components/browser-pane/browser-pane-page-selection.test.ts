import { describe, expect, it } from 'vitest'
import { getBrowserPagesForWorkspace } from './browser-pane-page-selection'
import type { BrowserPage } from '../../../../shared/types'

function makeBrowserPage(id: string): BrowserPage {
  return {
    id,
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: `https://example.com/${id}`,
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

describe('getBrowserPagesForWorkspace', () => {
  it('returns only the owning workspace page array so unrelated page updates keep the selector stable', () => {
    const pages = [makeBrowserPage('page-1')]
    const browserPagesByWorkspace = {
      workspaceA: pages,
      workspaceB: [makeBrowserPage('page-2')]
    }

    expect(getBrowserPagesForWorkspace(browserPagesByWorkspace, 'workspaceA')).toBe(pages)
    expect(
      getBrowserPagesForWorkspace(
        { ...browserPagesByWorkspace, workspaceB: [makeBrowserPage('page-3')] },
        'workspaceA'
      )
    ).toBe(pages)
    expect(getBrowserPagesForWorkspace(browserPagesByWorkspace, 'missing')).toBe(
      getBrowserPagesForWorkspace({}, 'missing')
    )
  })
})
