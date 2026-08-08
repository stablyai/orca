import { describe, expect, it } from 'vitest'
import type {
  BrowserPage,
  BrowserWorkspace,
  Tab,
  TabContentType,
  Worktree
} from '../../../../shared/types'
import type { SearchableBrowserPage } from '@/lib/browser-palette-search'
import type { SearchableSimulatorTab } from '@/lib/simulator-palette-search'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import {
  OPEN_TAB_SEARCH_QUERY_MAX_BYTES,
  OPEN_TAB_SEARCH_RESULT_LIMIT,
  searchOpenTabs,
  type OpenTabSearchInput,
  type OpenTabSearchResult
} from './open-tab-search'

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

const REPO_NAME = 'octo/rocket'

function makeTab(id: string, contentType: TabContentType, sortOrder = 0): Tab {
  return {
    id,
    entityId: `${id}-entity`,
    groupId: 'group-1',
    worktreeId: worktree.id,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 0
  }
}

function makeWorkspaceTab({
  id,
  title,
  contentType = 'terminal',
  secondaryText = 'Terminal tab',
  secondarySearchTexts,
  agentSnippets = [],
  tabSortIndex = 0,
  groupSortIndex = 0,
  isCurrentTab = false
}: {
  id: string
  title: string
  contentType?: 'terminal' | 'editor'
  secondaryText?: string
  secondarySearchTexts?: string[]
  agentSnippets?: string[]
  tabSortIndex?: number
  groupSortIndex?: number
  isCurrentTab?: boolean
}): SearchableWorkspaceTab {
  return {
    tab: makeTab(id, contentType) as SearchableWorkspaceTab['tab'],
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    groupSortIndex,
    tabSortIndex,
    title,
    secondaryText,
    titleSearchText: title,
    secondarySearchTexts: secondarySearchTexts ?? [secondaryText],
    agentMetadata: agentSnippets.length
      ? [{ paneKey: `${id}-pane`, textParts: [], snippetCandidates: agentSnippets }]
      : [],
    isCurrentTab,
    isCurrentWorktree: true
  }
}

function makeBrowserPage({
  id,
  title,
  url = 'https://example.com/one',
  workspaceLabel = null,
  isCurrentPage = false
}: {
  id: string
  title: string
  url?: string
  workspaceLabel?: string | null
  isCurrentPage?: boolean
}): SearchableBrowserPage {
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
    label: workspaceLabel ?? undefined,
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
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    isCurrentPage,
    isCurrentWorktree: true
  }
}

function makeSimulatorTab({
  id,
  label,
  isCurrentTab = false
}: {
  id: string
  label: string
  isCurrentTab?: boolean
}): SearchableSimulatorTab {
  return {
    tab: { ...makeTab(id, 'simulator'), label },
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    isCurrentTab,
    isCurrentWorktree: true
  }
}

function search(input: Partial<OpenTabSearchInput> & { query: string }): OpenTabSearchResult[] {
  return searchOpenTabs({
    workspaceTabs: [],
    browserPages: [],
    simulatorTabs: [],
    ...input
  })
}

describe('searchOpenTabs ranking', () => {
  it('ranks a title-prefix match above a title-substring match from another source', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'The zebra terminal' })],
      browserPages: [makeBrowserPage({ id: 'page-1', title: 'Zebra release notes' })]
    })

    expect(results.map((result) => result.id)).toEqual([
      'open-tab:browser:page-1',
      'open-tab:workspace:tab-1'
    ])
  })

  it('ranks any title match above any secondary match', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [
        makeWorkspaceTab({
          id: 'tab-secondary',
          title: 'Notes',
          contentType: 'editor',
          secondaryText: 'src/zebra.ts'
        })
      ],
      simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Trailing zebra' })]
    })

    expect(results.map((result) => result.id)).toEqual([
      'open-tab:simulator:sim-1',
      'open-tab:workspace:tab-secondary'
    ])
  })

  it('ranks a path match above an agent-snippet match on tabs in the same group', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [
        makeWorkspaceTab({
          id: 'tab-agent',
          title: 'Claude Code',
          agentSnippets: ['zebra migration plan'],
          tabSortIndex: 0
        }),
        makeWorkspaceTab({
          id: 'tab-path',
          title: 'Notes',
          contentType: 'editor',
          secondaryText: 'src/zebra.ts',
          tabSortIndex: 1
        })
      ]
    })

    expect(results.map((result) => result.id)).toEqual([
      'open-tab:workspace:tab-path',
      'open-tab:workspace:tab-agent'
    ])
  })

  it('breaks tier ties on source order, then on engine score', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [
        makeWorkspaceTab({ id: 'tab-late', title: 'Zebra two', tabSortIndex: 5 }),
        makeWorkspaceTab({ id: 'tab-early', title: 'Zebra one', tabSortIndex: 0 })
      ],
      browserPages: [makeBrowserPage({ id: 'page-1', title: 'Zebra page' })],
      simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Zebra emulator' })]
    })

    expect(results.map((result) => result.id)).toEqual([
      'open-tab:workspace:tab-early',
      'open-tab:workspace:tab-late',
      'open-tab:browser:page-1',
      'open-tab:simulator:sim-1'
    ])
  })

  it('keeps only the highest-ranked results once the cap is reached', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [0, 1, 2, 3, 4, 5].map((index) =>
        makeWorkspaceTab({
          id: `tab-${index}`,
          title: `Zebra ${index}`,
          tabSortIndex: index
        })
      )
    })

    expect(results).toHaveLength(OPEN_TAB_SEARCH_RESULT_LIMIT)
    expect(results.map((result) => result.id)).toEqual([
      'open-tab:workspace:tab-0',
      'open-tab:workspace:tab-1',
      'open-tab:workspace:tab-2',
      'open-tab:workspace:tab-3'
    ])
  })
})

describe('searchOpenTabs filtering', () => {
  // The focused tab is only unreachable from its own column; hiding it here would
  // make it unreachable from every other column's "+" too.
  it('still returns the focused tab, page and emulator', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Zebra tab', isCurrentTab: true })],
      browserPages: [makeBrowserPage({ id: 'page-1', title: 'Zebra page', isCurrentPage: true })],
      simulatorTabs: [
        makeSimulatorTab({ id: 'sim-1', label: 'Zebra emulator', isCurrentTab: true })
      ]
    })

    expect(results.map((result) => result.id)).toEqual([
      'open-tab:workspace:tab-1',
      'open-tab:browser:page-1',
      'open-tab:simulator:sim-1'
    ])
  })

  it('returns nothing for a query that only matches the worktree name', () => {
    expect(
      search({
        query: 'aurora',
        workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Notes' })],
        browserPages: [makeBrowserPage({ id: 'page-1', title: 'Release notes' })],
        simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Pixel 8' })]
      })
    ).toEqual([])
  })

  it('returns nothing for a query that only matches the repo name', () => {
    expect(
      search({
        query: 'rocket',
        workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Notes' })],
        browserPages: [makeBrowserPage({ id: 'page-1', title: 'Release notes' })],
        simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Pixel 8' })]
      })
    ).toEqual([])
  })

  it('keeps a browser workspace-label match in the secondary tier', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Zebra terminal' })],
      browserPages: [
        makeBrowserPage({ id: 'page-1', title: 'Release notes', workspaceLabel: 'Zebra staging' })
      ]
    })

    expect(results.map((result) => result.id)).toEqual([
      'open-tab:workspace:tab-1',
      'open-tab:browser:page-1'
    ])
  })

  it('keeps the simulator "ios simulator" alias match, which carries no ranges', () => {
    const results = search({
      query: 'ios sim',
      simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Pixel 8' })]
    })

    expect(results.map((result) => result.id)).toEqual(['open-tab:simulator:sim-1'])
  })
})

describe('searchOpenTabs result fields', () => {
  it('carries the matched secondary text and leaves it null for a title match', () => {
    const [secondary] = search({
      query: 'zebra',
      workspaceTabs: [
        makeWorkspaceTab({
          id: 'tab-1',
          title: 'Notes',
          contentType: 'editor',
          secondaryText: 'src/zebra.ts'
        })
      ]
    })
    const [title] = search({
      query: 'notes',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Notes' })]
    })

    expect(secondary.matchedText).toBe('src/zebra.ts')
    expect(title.matchedText).toBeNull()
  })

  it('carries the editor relative path even when the query matched the absolute path', () => {
    const [result] = search({
      query: '/tmp/wt-1/src',
      workspaceTabs: [
        makeWorkspaceTab({
          id: 'tab-1',
          title: 'zebra.ts',
          contentType: 'editor',
          secondaryText: 'src/zebra.ts',
          secondarySearchTexts: ['src/zebra.ts', '/tmp/wt-1/src/zebra.ts']
        })
      ]
    })

    expect(result).toMatchObject({
      source: 'workspace',
      relativePath: 'src/zebra.ts',
      matchedText: '/tmp/wt-1/src/zebra.ts'
    })
  })

  it('carries the activation identifiers each source needs', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Zebra tab' })],
      browserPages: [makeBrowserPage({ id: 'page-1', title: 'Zebra page' })],
      simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Zebra emulator' })]
    })

    expect(results).toMatchObject([
      {
        source: 'workspace',
        contentType: 'terminal',
        tabId: 'tab-1',
        entityId: 'tab-1-entity',
        groupId: 'group-1',
        worktreeId: 'wt-1'
      },
      {
        source: 'browser',
        contentType: 'browser',
        pageId: 'page-1',
        workspaceId: 'page-1-ws',
        worktreeId: 'wt-1'
      },
      {
        source: 'simulator',
        contentType: 'simulator',
        tabId: 'sim-1',
        groupId: 'group-1',
        worktreeId: 'wt-1'
      }
    ])
  })
})

describe('searchOpenTabs query guards', () => {
  it('returns nothing for an empty or whitespace-only query', () => {
    const workspaceTabs = [makeWorkspaceTab({ id: 'tab-1', title: 'Zebra tab' })]

    expect(search({ query: '', workspaceTabs })).toEqual([])
    expect(search({ query: '   ', workspaceTabs })).toEqual([])
  })

  it('returns nothing for an oversized query instead of searching', () => {
    const results = search({
      query: 'z'.repeat(OPEN_TAB_SEARCH_QUERY_MAX_BYTES + 1),
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'z'.repeat(4096) })]
    })

    expect(results).toEqual([])
  })
})
