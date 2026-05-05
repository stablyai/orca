import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace, Worktree } from '../../../shared/types'
import {
  searchBrowserPages,
  formatBrowserPaletteUrl,
  isBlankBrowserUrl
} from './browser-palette-search'

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

  it('matches against formatted URLs when title does not match', () => {
    const results = searchBrowserPages(
      [
        {
          page: makePage({
            id: 'page-1',
            title: 'Dashboard',
            url: 'https://app.example.com/settings'
          }),
          workspace: makeWorkspace({ id: 'ws-1' }),
          worktree: makeWorktree({ id: 'wt-1' }),
          repoName: 'repo/one',
          worktreeSortIndex: 1,
          isCurrentPage: false,
          isCurrentWorktree: false
        }
      ],
      'settings'
    )

    expect(results).toHaveLength(1)
    expect(results[0].secondaryRange).toEqual({ start: 16, end: 24 })
    expect(results[0].titleRange).toBeNull()
  })

  it('matches against raw URL when formatted URL does not match', () => {
    const results = searchBrowserPages(
      [
        {
          page: makePage({ id: 'page-1', title: 'Docs', url: 'https://docs.example.com/' }),
          workspace: makeWorkspace({ id: 'ws-1' }),
          worktree: makeWorktree({ id: 'wt-1' }),
          repoName: 'repo/one',
          worktreeSortIndex: 1,
          isCurrentPage: false,
          isCurrentWorktree: false
        }
      ],
      'https'
    )

    expect(results).toHaveLength(1)
    expect(results[0].secondaryRange).toEqual({ start: 0, end: 5 })
  })

  it('returns empty array when query matches nothing', () => {
    const results = searchBrowserPages(
      [
        {
          page: makePage({ id: 'page-1', title: 'Dashboard', url: 'https://example.com' }),
          workspace: makeWorkspace({ id: 'ws-1' }),
          worktree: makeWorktree({ id: 'wt-1', displayName: 'Feature' }),
          repoName: 'myrepo',
          worktreeSortIndex: 1,
          isCurrentPage: false,
          isCurrentWorktree: false
        }
      ],
      'zzzznonexistent'
    )

    expect(results).toHaveLength(0)
  })

  it('formats blank URLs as New Tab', () => {
    expect(formatBrowserPaletteUrl('about:blank')).toBe('New Tab')
    expect(formatBrowserPaletteUrl('data:text/html,')).toBe('New Tab')
  })

  it('identifies blank browser URLs', () => {
    expect(isBlankBrowserUrl('about:blank')).toBe(true)
    expect(isBlankBrowserUrl('data:text/html,')).toBe(true)
    expect(isBlankBrowserUrl('https://example.com')).toBe(false)
  })

  it('boosts current page and current worktree in scored results', () => {
    const entries = [
      {
        page: makePage({ id: 'page-other', title: 'React Docs', url: 'https://react.dev' }),
        workspace: makeWorkspace({
          id: 'ws-other',
          worktreeId: 'wt-other',
          activePageId: 'page-other'
        }),
        worktree: makeWorktree({ id: 'wt-other', displayName: 'Other' }),
        repoName: 'repo',
        worktreeSortIndex: 1,
        isCurrentPage: false,
        isCurrentWorktree: false
      },
      {
        page: makePage({
          id: 'page-current',
          workspaceId: 'ws-current',
          worktreeId: 'wt-current',
          title: 'React Native Docs',
          url: 'https://reactnative.dev'
        }),
        workspace: makeWorkspace({
          id: 'ws-current',
          worktreeId: 'wt-current',
          activePageId: 'page-current'
        }),
        worktree: makeWorktree({ id: 'wt-current', displayName: 'Current' }),
        repoName: 'repo',
        worktreeSortIndex: 1,
        isCurrentPage: true,
        isCurrentWorktree: true
      }
    ]

    const results = searchBrowserPages(entries, 'react')

    expect(results).toHaveLength(2)
    expect(results[0].pageId).toBe('page-current')
    expect(results[1].pageId).toBe('page-other')
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
