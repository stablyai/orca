import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
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

const worktreeA = makeWorktree()
const worktreeB = makeWorktree({
  id: 'wt-2',
  repoId: 'repo-2',
  displayName: 'Other Worktree'
})
const repoMap = new Map([
  ['repo-1', { displayName: 'repo/one' }],
  ['repo-2', { displayName: 'repo/two' }]
])
const worktreeOrder = new Map([
  ['wt-1', 0],
  ['wt-2', 1]
])

function buildFixture(
  overrides: Partial<Parameters<typeof buildSearchableBrowserPages>[0]> = {}
): ReturnType<typeof buildSearchableBrowserPages> {
  return buildSearchableBrowserPages({
    worktrees: [worktreeA, worktreeB],
    repoMap,
    worktreeOrder,
    browserTabsByWorktree: {
      'wt-1': [
        makeWorkspace({
          id: 'ws-1',
          activePageId: 'page-1',
          pageIds: ['page-1', 'page-2']
        }),
        makeWorkspace({
          id: 'ws-2',
          activePageId: 'page-3',
          pageIds: ['page-3']
        })
      ],
      'wt-2': [
        makeWorkspace({
          id: 'ws-3',
          worktreeId: 'wt-2',
          activePageId: 'page-4'
        })
      ]
    },
    browserPagesByWorkspace: {
      'ws-1': [
        makePage({ id: 'page-1', title: 'Docs' }),
        makePage({ id: 'page-2', title: 'Changelog' })
      ],
      'ws-2': [makePage({ id: 'page-3', workspaceId: 'ws-2', title: 'Issues' })],
      'ws-3': [
        makePage({
          id: 'page-4',
          workspaceId: 'ws-3',
          worktreeId: 'wt-2',
          title: 'Other Docs'
        })
      ]
    },
    activeBrowserTabId: 'ws-1',
    activeWorktreeId: 'wt-1',
    activeTabType: 'browser',
    ...overrides
  })
}

describe('buildSearchableBrowserPages', () => {
  it('treats an unstamped legacy worktree as local when its tab is stamped', () => {
    expect(
      buildFixture({
        worktrees: [worktreeA],
        unifiedTabsByWorktree: {
          'wt-1': [browserUnifiedTab('tab-local', 'ws-1', 'wt-1', 'local')]
        }
      }).map((entry) => entry.workspace.id)
    ).toEqual(['ws-1', 'ws-1', 'ws-2'])
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

  it('omits a browser row whose backing tab id is duplicated', () => {
    const browserTab = browserUnifiedTab('shared-tab', 'ws-1', 'wt-1')
    expect(
      buildSearchableBrowserPages({
        worktrees: [worktreeA],
        repoMap,
        worktreeOrder,
        browserTabsByWorktree: { 'wt-1': [makeWorkspace()] },
        browserPagesByWorkspace: { 'ws-1': [makePage()] },
        unifiedTabsByWorktree: {
          'wt-1': [browserTab, { ...browserTab, contentType: 'terminal' }]
        },
        activeBrowserTabId: null,
        activeWorktreeId: null,
        activeTabType: 'terminal'
      })
    ).toEqual([])
  })

  it('builds one entry per page across every workspace in a worktree', () => {
    const entries = buildFixture()

    expect(entries.map((entry) => entry.page.id)).toEqual(['page-1', 'page-2', 'page-3', 'page-4'])
    expect(entries.map((entry) => entry.workspace.id)).toEqual(['ws-1', 'ws-1', 'ws-2', 'ws-3'])
    expect(entries.map((entry) => entry.repoName)).toEqual([
      'repo/one',
      'repo/one',
      'repo/one',
      'repo/two'
    ])
    expect(entries.map((entry) => entry.worktreeSortIndex)).toEqual([0, 0, 0, 1])
  })

  it('marks isCurrentPage only for the active page of the active browser workspace', () => {
    expect(buildFixture().map((entry) => entry.isCurrentPage)).toEqual([true, false, false, false])
  })

  it('marks no page current when the active tab type is not browser', () => {
    expect(buildFixture({ activeTabType: 'terminal' }).map((entry) => entry.isCurrentPage)).toEqual(
      [false, false, false, false]
    )
  })

  it('marks isCurrentWorktree only for the active worktree', () => {
    expect(buildFixture().map((entry) => entry.isCurrentWorktree)).toEqual([
      true,
      true,
      true,
      false
    ])
  })

  it('returns an empty array for a worktree with no browser workspaces', () => {
    expect(
      buildSearchableBrowserPages({
        worktrees: [worktreeA],
        repoMap,
        worktreeOrder,
        browserTabsByWorktree: {},
        browserPagesByWorkspace: {},
        activeBrowserTabId: null,
        activeWorktreeId: 'wt-1',
        activeTabType: 'terminal'
      })
    ).toEqual([])
  })

  it('falls back to MAX_SAFE_INTEGER sort index for worktrees outside the order map', () => {
    const entries = buildSearchableBrowserPages({
      worktrees: [worktreeA],
      repoMap,
      worktreeOrder: new Map(),
      browserTabsByWorktree: { 'wt-1': [makeWorkspace()] },
      browserPagesByWorkspace: { 'ws-1': [makePage()] },
      activeBrowserTabId: null,
      activeWorktreeId: null,
      activeTabType: 'browser'
    })

    expect(entries[0].worktreeSortIndex).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('reads page recency from the owning workspace unified tab, clamped to page age', () => {
    function browserTab(overrides: Partial<Tab>): Tab {
      return {
        id: 'tab-ws-1',
        entityId: 'ws-1',
        groupId: 'group-1',
        worktreeId: 'wt-1',
        contentType: 'browser',
        label: 'Example',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 0,
        ...overrides
      }
    }

    const [unfocused] = buildSearchableBrowserPages({
      worktrees: [worktreeA],
      repoMap,
      worktreeOrder,
      browserTabsByWorktree: { 'wt-1': [makeWorkspace()] },
      browserPagesByWorkspace: { 'ws-1': [makePage()] },
      unifiedTabsByWorktree: { 'wt-1': [browserTab({})] },
      activeBrowserTabId: null,
      activeWorktreeId: null,
      activeTabType: 'browser'
    })
    expect(unfocused.lastActiveAt).toBeNull()

    const entries = buildSearchableBrowserPages({
      worktrees: [worktreeA],
      repoMap,
      worktreeOrder,
      browserTabsByWorktree: { 'wt-1': [makeWorkspace({ pageIds: ['page-1', 'page-2'] })] },
      browserPagesByWorkspace: {
        'ws-1': [makePage(), makePage({ id: 'page-2', createdAt: 9000 })]
      },
      unifiedTabsByWorktree: { 'wt-1': [browserTab({ lastFocusedAt: 4000 })] },
      activeBrowserTabId: null,
      activeWorktreeId: null,
      activeTabType: 'browser'
    })

    expect(entries.map((entry) => entry.lastActiveAt)).toEqual([4000, 9000])
    expect(entries.map((entry) => entry.lastFocusedAt)).toEqual([4000, undefined])
  })

  it('moves the workspace-focus proxy when the active browser page changes', () => {
    const browserTab: Tab = {
      id: 'tab-ws-1',
      entityId: 'ws-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'browser',
      label: 'Example',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      lastFocusedAt: 8_000
    }
    const pages = [makePage({ createdAt: 1_000 }), makePage({ id: 'page-2', createdAt: 2_000 })]
    const build = (activePageId: string) =>
      buildSearchableBrowserPages({
        worktrees: [worktreeA],
        repoMap,
        worktreeOrder,
        browserTabsByWorktree: {
          'wt-1': [makeWorkspace({ activePageId, pageIds: ['page-1', 'page-2'] })]
        },
        browserPagesByWorkspace: { 'ws-1': pages },
        unifiedTabsByWorktree: { 'wt-1': [browserTab] },
        activeBrowserTabId: null,
        activeWorktreeId: null,
        activeTabType: 'browser'
      })

    expect(build('page-1').map((entry) => entry.lastActiveAt)).toEqual([8_000, 2_000])
    expect(build('page-2').map((entry) => entry.lastActiveAt)).toEqual([1_000, 8_000])
    expect(build('page-1').map((entry) => entry.lastFocusedAt)).toEqual([8_000, undefined])
    expect(build('page-2').map((entry) => entry.lastFocusedAt)).toEqual([undefined, 8_000])
  })

  it('feeds Cmd+J browser search the same ranking as the inline builder did', () => {
    const results = searchBrowserPages(buildFixture(), 'docs')

    // Primary title proofs lead URL-only proofs even across worktrees.
    expect(results.map((result) => result.pageId)).toEqual(['page-1', 'page-4', 'page-2', 'page-3'])
    expect(results[0].isCurrentPage).toBe(true)
  })

  // Why this matters to the workspace index: it keeps the first browser tab per workspace id, so
  // it would lose a later owned tab if two ever reached the lookup. This pins that they cannot.
  it('omits a workspace claimed by more than one unified browser tab', () => {
    const entries = buildFixture({
      unifiedTabsByWorktree: {
        'wt-1': [
          browserUnifiedTab('tab-foreign', 'ws-1', 'wt-2'),
          browserUnifiedTab('tab-owned', 'ws-1', 'wt-1')
        ]
      }
    })

    expect(entries.some((entry) => entry.workspace.id === 'ws-1')).toBe(false)
  })

  // Why: a workspace whose only unified tab belongs to another worktree must stay hidden here.
  it('omits a workspace whose single unified browser tab is not owned by this worktree', () => {
    const entries = buildFixture({
      unifiedTabsByWorktree: { 'wt-1': [browserUnifiedTab('tab-foreign', 'ws-1', 'wt-2')] }
    })

    expect(entries.some((entry) => entry.workspace.id === 'ws-1')).toBe(false)
    expect(entries.some((entry) => entry.workspace.id === 'ws-2')).toBe(true)
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

it('indexes workspace tabs when building a large browser palette', () => {
  let reads = 0
  const workspaces = Array.from({ length: 1000 }, (_, i) =>
    makeWorkspace({ id: `workspace-${i}`, activePageId: `page-${i}` })
  )
  const tabs: Tab[] = workspaces.map((workspace, i) => ({
    id: `tab-${i}`,
    get entityId() {
      reads++
      return workspace.id
    },
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'browser',
    label: 'Example',
    customLabel: null,
    color: null,
    sortOrder: i,
    createdAt: 0
  }))
  const pages = Object.fromEntries(
    workspaces.map((workspace, i) => [
      workspace.id,
      [makePage({ id: `page-${i}`, workspaceId: workspace.id })]
    ])
  )
  const entries = buildFixture({
    worktrees: [worktreeA],
    browserTabsByWorktree: { 'wt-1': workspaces },
    browserPagesByWorkspace: pages,
    unifiedTabsByWorktree: { 'wt-1': tabs }
  })
  expect(reads).toBeLessThan(6000)
  expect(entries.map((entry) => entry.workspace.id)).toEqual(
    workspaces.map((workspace) => workspace.id)
  )
})
