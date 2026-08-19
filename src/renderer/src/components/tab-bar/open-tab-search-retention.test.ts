import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab, TabContentType } from '../../../../shared/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildSearchableBrowserPageDocument,
  type SearchableBrowserPage
} from '@/lib/browser-palette-search'
import { buildPaletteTabDocument } from '@/lib/palette-match/tab-document'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import { TERMINAL_TYPE_SEARCH_ALIASES } from '@/lib/workspace-tab-palette-search'
import { searchOpenTabs } from './open-tab-search'
import type { OpenTabSearchEntries } from './open-tab-search-entries'
import { retainOpenTabResultsForQuery } from './open-tab-search-retention'

const worktree: Worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/tmp/wt-1',
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: false,
  displayName: 'Aurora Workspace',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

function makeTab(id: string, contentType: TabContentType): Tab {
  return {
    id,
    entityId: `${id}-entity`,
    groupId: 'group-1',
    worktreeId: worktree.id,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeWorkspaceTab({
  id,
  title,
  contentType = 'terminal',
  secondarySearchTexts = [],
  agentSnippets = [],
  typeSearchAliases
}: {
  id: string
  title: string
  contentType?: 'terminal' | 'editor'
  secondarySearchTexts?: string[]
  agentSnippets?: string[]
  typeSearchAliases?: readonly string[]
}): SearchableWorkspaceTab {
  const aliases =
    typeSearchAliases ?? (contentType === 'terminal' ? TERMINAL_TYPE_SEARCH_ALIASES : undefined)
  return {
    tab: makeTab(id, contentType) as SearchableWorkspaceTab['tab'],
    worktree,
    repoName: 'octo/rocket',
    worktreeSortIndex: 0,
    groupSortIndex: 0,
    tabSortIndex: 0,
    title,
    secondaryText: secondarySearchTexts[0] ?? '',
    titleSearchText: title,
    secondarySearchTexts,
    typeSearchAliases: aliases,
    document: buildPaletteTabDocument({
      id,
      title,
      secondaryTexts: secondarySearchTexts,
      worktreeName: worktree.displayName ?? '',
      branch: 'main',
      repoName: 'octo/rocket',
      typeAliases: aliases
    }),
    agentMetadata: agentSnippets.length
      ? [{ paneKey: `${id}-pane`, textParts: [], snippetCandidates: agentSnippets }]
      : [],
    occupantAgent: null,
    isCurrentTab: false,
    isCurrentWorktree: true
  }
}

function makeBrowserPage({
  id,
  title,
  workspaceLabel
}: {
  id: string
  title: string
  workspaceLabel?: string
}): SearchableBrowserPage {
  const url = 'https://example.com/one'
  const page: BrowserPage = {
    id,
    workspaceId: `${id}-ws`,
    worktreeId: worktree.id,
    url,
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
  const workspace: BrowserWorkspace = {
    id: `${id}-ws`,
    worktreeId: worktree.id,
    activePageId: id,
    pageIds: [id],
    url,
    title,
    label: workspaceLabel,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
  return {
    page,
    workspace,
    worktree,
    repoName: 'octo/rocket',
    worktreeSortIndex: 0,
    document: buildSearchableBrowserPageDocument({
      page,
      workspace,
      worktree,
      repoName: 'octo/rocket'
    }),
    isCurrentPage: false,
    isCurrentWorktree: true
  }
}

function makeEntries(overrides: Partial<OpenTabSearchEntries> = {}): OpenTabSearchEntries {
  return { workspaceTabs: [], browserPages: [], simulatorTabs: [], ...overrides }
}

// Mirrors the hook: the deferred query builds the rows, the live query re-checks them.
function retain({
  entries,
  deferredQuery,
  query
}: {
  entries: OpenTabSearchEntries
  deferredQuery: string
  query: string
}): { titles: string[]; sameList: boolean } {
  const results = searchOpenTabs({ ...entries, query: deferredQuery })
  const retained = retainOpenTabResultsForQuery({
    entries,
    query,
    results,
    resultsQuery: deferredQuery
  })
  return { titles: retained.map((result) => result.title), sameList: retained === results }
}

describe('retainOpenTabResultsForQuery', () => {
  const entries = makeEntries({
    workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Add tab search and jump in worktree' })]
  })

  it('returns the same list when the deferred query has caught up', () => {
    expect(retain({ entries, deferredQuery: 'add tab', query: 'add tab' })).toEqual({
      titles: ['Add tab search and jump in worktree'],
      sameList: true
    })
  })

  it('treats extra surrounding whitespace as the same query', () => {
    expect(retain({ entries, deferredQuery: 'add tab', query: '  add tab ' })).toEqual({
      titles: ['Add tab search and jump in worktree'],
      sameList: true
    })
  })

  it('keeps rows while the user backspaces into a prefix of the deferred query', () => {
    expect(retain({ entries, deferredQuery: 'add tab', query: 'add ta' }).titles).toEqual([
      'Add tab search and jump in worktree'
    ])
  })

  it('keeps the same array when nothing was dropped, so the row memos hold', () => {
    expect(retain({ entries, deferredQuery: 'add tab', query: 'add ta' }).sameList).toBe(true)
  })

  it('drops rows the newer query no longer matches', () => {
    expect(retain({ entries, deferredQuery: 'add tab', query: 'add tabs' }).titles).toEqual([])
  })

  it('drops every row once the live query is cleared', () => {
    expect(retain({ entries, deferredQuery: 'add tab', query: '   ' }).titles).toEqual([])
  })

  // The row text alone cannot answer these three: the engines match fields the
  // result never carries once the match came from somewhere else.
  it('keeps a terminal row the newer query matches through its type alias', () => {
    const aliased = makeEntries({
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'zsh' })]
    })
    expect(retain({ entries: aliased, deferredQuery: 'term', query: 'termin' }).titles).toEqual([
      'zsh'
    ])
  })

  it('keeps a browser row the newer query matches through its workspace label', () => {
    const labelled = makeEntries({
      browserPages: [
        makeBrowserPage({ id: 'page-1', title: 'Untitled', workspaceLabel: 'Release checklist' })
      ]
    })
    expect(retain({ entries: labelled, deferredQuery: 'rele', query: 'release c' }).titles).toEqual(
      ['Untitled']
    )
  })

  it('keeps an editor row the newer query matches through its absolute path', () => {
    const editor = makeEntries({
      workspaceTabs: [
        makeWorkspaceTab({
          id: 'tab-1',
          title: 'zebra.ts',
          contentType: 'editor',
          secondarySearchTexts: ['src/zebra.ts', '/tmp/wt-1/src/zebra.ts']
        })
      ]
    })
    expect(
      retain({ entries: editor, deferredQuery: 'zeb', query: '/tmp/wt-1/src' }).titles
    ).toEqual(['zebra.ts'])
  })

  it('keeps a row the newer query matches through an agent snippet', () => {
    const withAgent = makeEntries({
      workspaceTabs: [
        makeWorkspaceTab({
          id: 'tab-1',
          title: 'zsh',
          agentSnippets: ['rewriting the deferred retention path']
        })
      ]
    })
    expect(
      retain({ entries: withAgent, deferredQuery: 'defer', query: 'deferred ret' }).titles
    ).toEqual(['zsh'])
  })

  it('drops a row whose only remaining match is the workspace name the search ignores', () => {
    const named = makeEntries({
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'zsh' })]
    })
    expect(retain({ entries: named, deferredQuery: 'zsh', query: 'aurora' }).titles).toEqual([])
  })

  it('drops every row when the entries behind them are gone', () => {
    const results = searchOpenTabs({ ...entries, query: 'add tab' })
    expect(
      retainOpenTabResultsForQuery({
        entries: null,
        query: 'add ta',
        results,
        resultsQuery: 'add tab'
      })
    ).toEqual([])
  })
})
