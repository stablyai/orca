import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  BROWSER_PALETTE_QUERY_MAX_BYTES,
  buildSearchableBrowserPageDocument,
  searchBrowserPages,
  type SearchableBrowserPage
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

/** Mirrors the production builder so fixtures index exactly what Cmd+J indexes. */
function makeEntry(entry: Omit<SearchableBrowserPage, 'document'>): SearchableBrowserPage {
  return { ...entry, document: buildSearchableBrowserPageDocument(entry) }
}

describe('browser-palette-search', () => {
  it('rejects a query with more unique tokens than the matcher accepts', () => {
    const query = 't0 t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12 t13 t14 t15 t16'
    const entries = [
      makeEntry({
        page: makePage({ id: 'page-1', title: query }),
        workspace: makeWorkspace({ id: 'ws-1' }),
        worktree: makeWorktree({ id: 'wt-1' }),
        repoName: 'repo/one',
        worktreeSortIndex: 1,
        isCurrentPage: false,
        isCurrentWorktree: false
      })
    ]

    expect(
      searchBrowserPages(entries, 't0 t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12 t13 t14 t15')
    ).toHaveLength(1)
    expect(searchBrowserPages(entries, query)).toEqual([])
  })

  it('rejects oversized pasted queries before scanning browser pages', () => {
    const oversizedQuery = 'secret-browser-palette'.repeat(BROWSER_PALETTE_QUERY_MAX_BYTES)
    const entry = {
      get page(): BrowserPage {
        throw new Error('oversized browser palette queries must not scan pages')
      },
      workspace: makeWorkspace(),
      worktree: makeWorktree(),
      repoName: 'repo',
      worktreeSortIndex: 0,
      isCurrentPage: false,
      isCurrentWorktree: false,
      document: buildSearchableBrowserPageDocument({
        page: makePage(),
        workspace: makeWorkspace(),
        worktree: makeWorktree(),
        repoName: 'repo'
      })
    } as SearchableBrowserPage

    expect(searchBrowserPages([entry], oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming', () => {
    const entry = makeEntry({
      page: makePage(),
      workspace: makeWorkspace(),
      worktree: makeWorktree(),
      repoName: 'repo',
      worktreeSortIndex: 0,
      isCurrentPage: false,
      isCurrentWorktree: false
    })
    expect(searchBrowserPages([entry], ' '.repeat(2048)).map((result) => result.pageId)).toEqual([
      'page-1'
    ])
    expect(searchBrowserPages([entry], ' '.repeat(2049))).toEqual([])
  })
})
