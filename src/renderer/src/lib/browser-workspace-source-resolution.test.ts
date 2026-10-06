import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import { resolveBrowserSourceUnifiedTab } from './browser-workspace-source-resolution'

const WT = 'wt-1'

type ResolverState = Parameters<typeof resolveBrowserSourceUnifiedTab>[0]

function wrapper(id: string, workspaceId: string, groupId = 'group-1'): Tab {
  return {
    id,
    entityId: workspaceId,
    groupId,
    worktreeId: WT,
    contentType: 'browser',
    label: 'Example',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function workspace(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: WT,
    activePageId: null,
    pageIds: [],
    url: 'about:blank',
    title: '',
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
    worktreeId: WT,
    url: 'about:blank',
    title: '',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function makeState(overrides: {
  workspaces?: string[]
  pages?: Record<string, string[]>
  wrappers?: Tab[]
  groups?: TabGroup[]
}): ResolverState {
  const workspaces = overrides.workspaces ?? ['ws-1']
  const pages = overrides.pages ?? { 'ws-1': ['page-1'] }
  const wrappers = overrides.wrappers ?? [wrapper('tab-1', 'ws-1')]
  return {
    browserTabsByWorktree: {
      [WT]: workspaces.map(workspace)
    },
    browserPagesByWorkspace: Object.fromEntries(
      Object.entries(pages).map(([workspaceId, ids]) => [
        workspaceId,
        ids.map((id) => page(id, workspaceId))
      ])
    ),
    unifiedTabsByWorktree: { [WT]: wrappers },
    groupsByWorktree: {
      [WT]: overrides.groups ?? [
        { id: 'group-1', worktreeId: WT, activeTabId: null, tabOrder: wrappers.map((t) => t.id) }
      ]
    }
  }
}

describe('resolveBrowserSourceUnifiedTab', () => {
  it('returns the unique live wrapper for a source page', () => {
    expect(resolveBrowserSourceUnifiedTab(makeState({}), 'page-1', WT)?.id).toBe('tab-1')
  })

  it('stays inside the caller workspace', () => {
    expect(resolveBrowserSourceUnifiedTab(makeState({}), 'page-1', 'wt-other')).toBeUndefined()
  })

  it('omits the anchor for ambiguous wrappers', () => {
    const state = makeState({ wrappers: [wrapper('tab-1', 'ws-1'), wrapper('tab-2', 'ws-1')] })
    expect(resolveBrowserSourceUnifiedTab(state, 'page-1', WT)).toBeUndefined()
  })

  it('omits the anchor when two workspaces claim the page', () => {
    const state = makeState({
      workspaces: ['ws-1', 'ws-2'],
      pages: { 'ws-1': ['page-1'], 'ws-2': ['page-1'] }
    })
    expect(resolveBrowserSourceUnifiedTab(state, 'page-1', WT)).toBeUndefined()
  })

  it('omits the anchor for a closed page or a wrapper outside its group order', () => {
    expect(resolveBrowserSourceUnifiedTab(makeState({}), 'closed-page', WT)).toBeUndefined()
    const detached = makeState({
      groups: [{ id: 'group-1', worktreeId: WT, activeTabId: null, tabOrder: [] }]
    })
    expect(resolveBrowserSourceUnifiedTab(detached, 'page-1', WT)).toBeUndefined()
  })
})
