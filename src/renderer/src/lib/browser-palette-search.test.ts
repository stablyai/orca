import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace, Worktree } from '../../../shared/types'
import { searchBrowserPages, formatBrowserPaletteUrl } from './browser-palette-search'

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
    isArchived: false,
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeWorkspace(overrides: Partial<BrowserWorkspace> = {}): BrowserWorkspace {
  return {
    id: 'browser-workspace-1',
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
    workspaceId: 'browser-workspace-1',
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

describe('browser-palette-search', () => {
  it('formats browser urls without protocol for palette display', () => {
    expect(formatBrowserPaletteUrl('https://example.com/docs?q=1#hash')).toBe(
      'example.com/docs?q=1#hash'
    )
  })

  it('keeps empty-query ordering deterministic and context-first', () => {
    const results = searchBrowserPages(
      [
        {
          page: makePage({ id: 'page-current', title: 'Current Page' }),
          workspace: makeWorkspace({ id: 'ws-current', activePageId: 'page-current' }),
          worktree: makeWorktree({ id: 'wt-current', displayName: 'Current WT' }),
          repoName: 'repo/current',
          worktreeSortIndex: 1,
          isCurrentPage: true,
          isCurrentWorktree: true
        },
        {
          page: makePage({
            id: 'page-sibling',
            workspaceId: 'ws-sibling',
            worktreeId: 'wt-current',
            title: 'Sibling Page',
            url: 'https://example.com/sibling'
          }),
          workspace: makeWorkspace({
            id: 'ws-sibling',
            worktreeId: 'wt-current',
            activePageId: 'page-sibling'
          }),
          worktree: makeWorktree({ id: 'wt-current', displayName: 'Current WT' }),
          repoName: 'repo/current',
          worktreeSortIndex: 1,
          isCurrentPage: false,
          isCurrentWorktree: true
        },
        {
          page: makePage({
            id: 'page-other',
            workspaceId: 'ws-other',
            worktreeId: 'wt-other',
            title: 'Other Page',
            url: 'https://example.com/other'
          }),
          workspace: makeWorkspace({
            id: 'ws-other',
            worktreeId: 'wt-other',
            activePageId: 'page-other'
          }),
          worktree: makeWorktree({ id: 'wt-other', displayName: 'Other WT', repoId: 'repo-2' }),
          repoName: 'repo/other',
          worktreeSortIndex: 2,
          isCurrentPage: false,
          isCurrentWorktree: false
        }
      ],
      ''
    )

    expect(results.map((result) => result.pageId)).toEqual([
      'page-current',
      'page-sibling',
      'page-other'
    ])
  })

  it('searches against page titles before worktree metadata', () => {
    const results = searchBrowserPages(
      [
        {
          page: makePage({ id: 'page-1', title: 'Design Spec' }),
          workspace: makeWorkspace({ id: 'ws-1' }),
          worktree: makeWorktree({ id: 'wt-1', displayName: 'Unrelated' }),
          repoName: 'repo/one',
          worktreeSortIndex: 1,
          isCurrentPage: false,
          isCurrentWorktree: false
        },
        {
          page: makePage({
            id: 'page-2',
            workspaceId: 'ws-2',
            worktreeId: 'wt-2',
            title: 'Home',
            url: 'https://example.com/home'
          }),
          workspace: makeWorkspace({ id: 'ws-2', worktreeId: 'wt-2', activePageId: 'page-2' }),
          worktree: makeWorktree({ id: 'wt-2', repoId: 'repo-2', displayName: 'Design Review' }),
          repoName: 'repo/two',
          worktreeSortIndex: 2,
          isCurrentPage: false,
          isCurrentWorktree: false
        }
      ],
      'design'
    )

    expect(results).toHaveLength(2)
    expect(results[0].pageId).toBe('page-1')
    expect(results[0].titleRange).toEqual({ start: 0, end: 6 })
    expect(results[1].worktreeRange).toEqual({ start: 0, end: 6 })
  })

  it('matches the visible workspace label in browser search', () => {
    const results = searchBrowserPages(
      [
        {
          page: makePage({ id: 'page-1', title: 'Docs' }),
          workspace: makeWorkspace({ id: 'ws-1', label: 'Browser 7' }),
          worktree: makeWorktree({ id: 'wt-1', displayName: 'Palette Worktree' }),
          repoName: 'repo/one',
          worktreeSortIndex: 1,
          isCurrentPage: false,
          isCurrentWorktree: false
        }
      ],
      'browser 7'
    )

    expect(results).toHaveLength(1)
    expect(results[0].workspaceRange).toEqual({ start: 0, end: 9 })
  })
})
