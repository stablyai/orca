import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../../shared/tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import { buildSearchableBrowserPages } from './browser-palette-page-entries'
import { searchBrowserPages } from './browser-palette-search'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature/browser-search',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Palette Worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeWorkspace(overrides: Partial<BrowserWorkspace> = {}): BrowserWorkspace {
  return {
    id: 'ws-1',
    worktreeId: 'wt-1',
    activePageId: 'page-1',
    pageIds: ['page-1'],
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

function makePage(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id: 'page-1',
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    url: 'https://example.com/docs',
    title: 'Project Docs',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

const repoMap = new Map([
  ['repo-1', { displayName: 'repo/one' }],
  ['repo-2', { displayName: 'repo/two' }]
])
const worktreeOrder = new Map([
  ['wt-1', 0],
  ['wt-2', 1]
])

describe('buildSearchableBrowserPages', () => {
  it('lists a remote source-owned page at its local floating placement', () => {
    const entries = buildSearchableBrowserPages({
      worktrees: [makeWorktree({ hostId: 'runtime:paired' })],
      repoMap,
      worktreeOrder,
      browserTabsByWorktree: { 'wt-1': [makeWorkspace()] },
      browserPagesByWorkspace: { 'ws-1': [makePage({ browserRuntimeEnvironmentId: 'paired' })] },
      unifiedTabsByWorktree: {
        'global-floating-terminal': [
          {
            id: 'floating-view',
            entityId: 'ws-1',
            worktreeId: 'global-floating-terminal',
            executionHostId: 'local',
            groupId: 'floating-group',
            contentType: 'browser',
            label: 'Docs',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabId: null,
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal'
    })
    expect(entries).toMatchObject([
      {
        worktree: { id: 'global-floating-terminal' },
        executionHostId: 'local',
        page: { worktreeId: 'wt-1', browserRuntimeEnvironmentId: 'paired' }
      }
    ])
  })

  it('keeps same-id browser tabs isolated by execution host', () => {
    const sharedId = 'repo-shared::/workspace'
    const local = makeWorktree({ id: sharedId, hostId: 'local', displayName: 'Local workspace' })
    const remote = makeWorktree({
      id: sharedId,
      hostId: 'runtime:host-b',
      displayName: 'Remote workspace'
    })
    const localWorkspace = makeWorkspace({
      id: 'ws-local',
      worktreeId: sharedId,
      activePageId: 'page-local'
    })
    const remoteWorkspace = makeWorkspace({
      id: 'ws-remote',
      worktreeId: sharedId,
      activePageId: 'page-remote'
    })
    const entries = buildSearchableBrowserPages({
      worktrees: [local, remote],
      repoMap,
      worktreeOrder: new Map([
        [getWorktreeHostIdentity(local), 0],
        [getWorktreeHostIdentity(remote), 1]
      ]),
      browserTabsByWorktree: {
        [sharedId]: [localWorkspace, remoteWorkspace]
      },
      browserPagesByWorkspace: {
        'ws-local': [
          makePage({
            id: 'page-local',
            workspaceId: 'ws-local',
            worktreeId: sharedId,
            title: 'Local docs'
          })
        ],
        'ws-remote': [
          makePage({
            id: 'page-remote',
            workspaceId: 'ws-remote',
            worktreeId: sharedId,
            title: 'Remote docs'
          })
        ]
      },
      unifiedTabsByWorktree: {
        [sharedId]: [
          browserUnifiedTab('tab-local', 'ws-local', sharedId, 'local'),
          browserUnifiedTab('tab-remote', 'ws-remote', sharedId, 'runtime:host-b')
        ]
      },
      activeBrowserTabId: null,
      activeWorktreeId: null,
      activeTabType: 'terminal'
    })

    expect(entries.map((entry) => [entry.page.id, entry.worktree.hostId])).toEqual([
      ['page-local', 'local'],
      ['page-remote', 'runtime:host-b']
    ])
    expect(
      searchBrowserPages(entries, 'docs').map((result) => [result.pageId, result.executionHostId])
    ).toEqual([
      ['page-local', 'local'],
      ['page-remote', 'runtime:host-b']
    ])
  })

  it('does not re-host a tab whose stamped owner is absent from the catalog', () => {
    const sharedId = 'repo-shared::/workspace'
    const remote = makeWorktree({ id: sharedId, hostId: 'runtime:host-b' })
    const entries = buildSearchableBrowserPages({
      worktrees: [remote],
      repoMap,
      worktreeOrder: new Map([[getWorktreeHostIdentity(remote), 0]]),
      browserTabsByWorktree: {
        [sharedId]: [
          makeWorkspace({ id: 'ws-local', worktreeId: sharedId, activePageId: 'page-local' })
        ]
      },
      browserPagesByWorkspace: {
        'ws-local': [makePage({ id: 'page-local', workspaceId: 'ws-local', worktreeId: sharedId })]
      },
      unifiedTabsByWorktree: {
        [sharedId]: [browserUnifiedTab('tab-local', 'ws-local', sharedId, 'local')]
      },
      activeBrowserTabId: null,
      activeWorktreeId: null,
      activeTabType: 'terminal'
    })

    expect(entries).toEqual([])
  })

  it('does not route one ambiguous legacy browser bucket to both hosts', () => {
    const sharedId = 'repo-shared::/workspace'
    const workspace = makeWorkspace({ worktreeId: sharedId })

    expect(
      buildSearchableBrowserPages({
        worktrees: [
          makeWorktree({ id: sharedId, hostId: 'local' }),
          makeWorktree({ id: sharedId, hostId: 'runtime:host-b' })
        ],
        repoMap,
        worktreeOrder,
        browserTabsByWorktree: { [sharedId]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [makePage({ worktreeId: sharedId })] },
        activeBrowserTabId: null,
        activeWorktreeId: null,
        activeTabType: 'terminal'
      })
    ).toEqual([])
  })
})

function browserUnifiedTab(
  id: string,
  entityId: string,
  worktreeId: string,
  executionHostId?: Tab['executionHostId']
): Tab {
  return {
    id,
    entityId,
    groupId: `group-${id}`,
    worktreeId,
    ...(executionHostId ? { executionHostId } : {}),
    contentType: 'browser',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
