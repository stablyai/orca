import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import { projectHydratedBrowserSession } from './browser-hydration-state'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const WT = 'repo-1::/srv/wt'

/** A frame published between the server's openBrowserTab and its page record: the tab names its page. */
function frameBeforePageRecord(
  tab: { activePageId?: string; pageIds?: string[] } = { pageIds: ['host-page-1'] }
): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    browserTabsByWorktree: {
      [WT]: [
        {
          id: 'host-page-1',
          worktreeId: WT,
          url: 'about:blank',
          title: 'New Tab',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1,
          ...tab
        }
      ]
    },
    browserPagesByWorkspace: {}
  }
}

function hydratedPageIds(tab?: { activePageId?: string; pageIds?: string[] }): {
  pageIds: string[]
  workspacePageIds: string[]
} {
  const projected = projectHydratedBrowserSession(
    {
      activeWorktreeId: null,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: {},
      openFiles: [],
      tabsByWorktree: {}
    },
    frameBeforePageRecord(tab),
    new Set([WT])
  )
  return {
    pageIds: (projected.browserPagesByWorkspace['host-page-1'] ?? []).map((page) => page.id),
    workspacePageIds: projected.browserTabsByWorktree[WT]?.[0]?.pageIds ?? []
  }
}

describe('projectHydratedBrowserSession for a tab whose page record has not landed', () => {
  it('names the page by the id the tab records, the same on every frame build', () => {
    layoutOwner.isMain = true

    const first = hydratedPageIds()
    const second = hydratedPageIds()

    expect(first).toEqual({ pageIds: ['host-page-1'], workspacePageIds: ['host-page-1'] })
    expect(second).toEqual(first)
  })

  // The page a host starts for a saved tab is its active one (ServeBrowserTabs.startableIn).
  it('prefers the page the tab records as active', () => {
    layoutOwner.isMain = true

    const { pageIds } = hydratedPageIds({
      activePageId: 'host-page-2',
      pageIds: ['host-page-1', 'host-page-2']
    })

    expect(pageIds).toEqual(['host-page-2'])
  })

  it('keeps minting a fresh page id with the layout-owner switch off', () => {
    layoutOwner.isMain = false

    const { pageIds, workspacePageIds } = hydratedPageIds()

    expect(pageIds).toHaveLength(1)
    expect(pageIds[0]).not.toBe('host-page-1')
    expect(workspacePageIds).toEqual(pageIds)
  })
})
