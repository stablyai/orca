import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace, Worktree } from '../../../shared/types'
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

  it('feeds Cmd+J browser search the same ranking as the inline builder did', () => {
    const results = searchBrowserPages(buildFixture(), 'docs')

    // Current page first, then the two url-only matches in the active worktree,
    // then the other worktree's title match.
    expect(results.map((result) => result.pageId)).toEqual(['page-1', 'page-2', 'page-3', 'page-4'])
    expect(results[0].isCurrentPage).toBe(true)
  })
})
