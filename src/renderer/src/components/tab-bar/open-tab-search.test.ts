import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab, TabContentType } from '../../../../shared/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildPaletteTabDocument } from '@/lib/palette-match/tab-document'
import { PALETTE_QUERY_MAX_TOKENS } from '@/lib/palette-match/palette-query'
import {
  buildSearchableBrowserPageDocument,
  type SearchableBrowserPage
} from '@/lib/browser-palette-search'
import {
  SIMULATOR_TYPE_SEARCH_ALIASES,
  simulatorPaletteTabTitle,
  type SearchableSimulatorTab
} from '@/lib/simulator-palette-search'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import {
  OPEN_TAB_SEARCH_QUERY_MAX_BYTES,
  OPEN_TAB_SEARCH_RESULT_LIMIT,
  searchOpenTabs,
  type OpenTabSearchInput,
  type OpenTabSearchResult
} from './open-tab-search'
import { createPaletteSearchContext } from '@/lib/palette-match/palette-ranking'

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
const WORKTREE_NAME = worktree.displayName
const BRANCH_NAME = 'main'

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
  secondaryText = '',
  secondarySearchTexts,
  agentSnippets = [],
  occupantAgent = null,
  tabSortIndex = 0,
  groupSortIndex = 0,
  isCurrentTab = false,
  createdAt = 0
}: {
  id: string
  title: string
  contentType?: 'terminal' | 'editor'
  secondaryText?: string
  secondarySearchTexts?: string[]
  agentSnippets?: string[]
  occupantAgent?: SearchableWorkspaceTab['occupantAgent']
  tabSortIndex?: number
  groupSortIndex?: number
  isCurrentTab?: boolean
  createdAt?: number
}): SearchableWorkspaceTab {
  const searchTexts = secondarySearchTexts ?? (secondaryText ? [secondaryText] : [])
  const tab = makeTab(id, contentType) as SearchableWorkspaceTab['tab']
  tab.createdAt = createdAt
  return {
    tab,
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    groupSortIndex,
    tabSortIndex,
    title,
    secondaryText,
    titleSearchText: title,
    secondarySearchTexts: searchTexts,
    document: buildPaletteTabDocument({
      id,
      title,
      secondaryTexts: searchTexts,
      worktreeName: WORKTREE_NAME,
      branch: BRANCH_NAME,
      repoName: REPO_NAME
    }),
    agentMetadata: agentSnippets.length
      ? [
          {
            paneKey: `${id}-pane`,
            textParts: [],
            snippetCandidates: agentSnippets,
            lastActivityAt: 0
          }
        ]
      : [],
    occupantAgent,
    isCurrentTab,
    isCurrentWorktree: true
  }
}

function makeBrowserPage({
  id,
  title,
  url = 'https://example.com/one',
  faviconUrl = null,
  workspaceLabel = null,
  isCurrentPage = false
}: {
  id: string
  title: string
  url?: string
  faviconUrl?: string | null
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
    faviconUrl,
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
    isCurrentWorktree: true,
    document: buildSearchableBrowserPageDocument({
      page,
      workspace,
      worktree,
      repoName: REPO_NAME
    })
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
  const tab = { ...makeTab(id, 'simulator'), label }
  return {
    tab,
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    isCurrentTab,
    isCurrentWorktree: true,
    document: buildPaletteTabDocument({
      id: tab.id,
      title: simulatorPaletteTabTitle(tab),
      secondaryTexts: [],
      worktreeName: WORKTREE_NAME,
      branch: BRANCH_NAME,
      repoName: REPO_NAME,
      typeAliases: SIMULATOR_TYPE_SEARCH_ALIASES
    })
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

function readableId(result: OpenTabSearchResult): string {
  return `open-tab:${result.source}:${result.source === 'browser' ? result.pageId : result.tabId}`
}

describe('searchOpenTabs ranking', () => {
  it('uses the shared Atlas order before applying the four-row cap', () => {
    const now = 100 * 24 * 60 * 60 * 1000
    const age = (milliseconds: number): number => now - milliseconds
    const workspaceTabs = [
      makeWorkspaceTab({
        id: 'old-prefix-2d',
        title: 'atlas-follow-up-draft-2026-09-01.md',
        createdAt: age(2 * 24 * 60 * 60 * 1000)
      }),
      makeWorkspaceTab({
        id: 'old-prefix-3d',
        title: 'atlas-meeting-todo.md',
        createdAt: age(3 * 24 * 60 * 60 * 1000)
      }),
      makeWorkspaceTab({
        id: 'recent-title',
        title: 'Clarify Atlas action items',
        createdAt: age(30_000)
      }),
      makeWorkspaceTab({
        id: 'recent-path',
        title: 'questions-and-answers.md',
        secondaryText: 'notes/atlas/questions.md',
        createdAt: age(30 * 60 * 1000)
      }),
      makeWorkspaceTab({
        id: 'older-path',
        title: 'worklog.md',
        secondaryText: 'notes/atlas/worklog.md',
        createdAt: age(9 * 60 * 60 * 1000)
      }),
      makeWorkspaceTab({
        id: 'older-title',
        title: 'Advance Atlas security review',
        createdAt: age(19 * 60 * 60 * 1000)
      })
    ]
    const results = search({
      query: 'atlas',
      context: createPaletteSearchContext(now),
      workspaceTabs
    })

    expect(results.map((result) => (result.source === 'workspace' ? result.tabId : ''))).toEqual([
      'recent-title',
      'older-title',
      'old-prefix-2d',
      'old-prefix-3d'
    ])
  })

  it('ranks a title-prefix match above a title-substring match from another source', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'The zebra terminal' })],
      browserPages: [makeBrowserPage({ id: 'page-1', title: 'Zebra release notes' })]
    })

    expect(results.map(readableId)).toEqual(['open-tab:browser:page-1', 'open-tab:workspace:tab-1'])
  })

  it('ranks a primary word match above a comparable secondary word match', () => {
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

    expect(results.map(readableId)).toEqual([
      'open-tab:simulator:sim-1',
      'open-tab:workspace:tab-secondary'
    ])
  })

  // Both use secondary coverage, so match rank has to beat tab position: the
  // agent tab sits earlier in the group and would win a position-only tie-break.
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

    expect(results.map(readableId)).toEqual([
      'open-tab:workspace:tab-path',
      'open-tab:workspace:tab-agent'
    ])
  })

  it('breaks semantic and activity ties on source order, then engine score', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [
        makeWorkspaceTab({ id: 'tab-late', title: 'Zebra two', tabSortIndex: 5 }),
        makeWorkspaceTab({ id: 'tab-early', title: 'Zebra one', tabSortIndex: 0 })
      ],
      browserPages: [makeBrowserPage({ id: 'page-1', title: 'Zebra page' })],
      simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Zebra emulator' })]
    })

    expect(results.map(readableId)).toEqual([
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
    expect(results.map(readableId)).toEqual([
      'open-tab:workspace:tab-0',
      'open-tab:workspace:tab-1',
      'open-tab:workspace:tab-2',
      'open-tab:workspace:tab-3'
    ])
  })

  it('reserves one capped slot for a retained eligible result', () => {
    const input = {
      query: 'zebra',
      workspaceTabs: [0, 1, 2, 3, 4].map((index) =>
        makeWorkspaceTab({ id: `tab-${index}`, title: `Zebra ${index}`, tabSortIndex: index })
      )
    }
    const uncappedSelection = searchOpenTabs({
      browserPages: [],
      simulatorTabs: [],
      ...input
    })[3]
    input.workspaceTabs[4].tab.createdAt = Date.now()
    const retained = searchOpenTabs({
      browserPages: [],
      simulatorTabs: [],
      ...input,
      retainedResultId: uncappedSelection.id
    })

    expect(retained).toHaveLength(OPEN_TAB_SEARCH_RESULT_LIMIT)
    expect(retained.some((result) => result.id === uncappedSelection.id)).toBe(true)
  })

  it('ranks an exact browser destination above a workspace typo', () => {
    const results = search({
      query: 'zebra',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-typo', title: 'zebrb' })],
      browserPages: [makeBrowserPage({ id: 'page-exact', title: 'Notes', url: 'zebra' })]
    })

    expect(results.map(readableId)).toEqual([
      'open-tab:browser:page-exact',
      'open-tab:workspace:tab-typo'
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

    expect(results.map(readableId)).toEqual([
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

    expect(results.map(readableId)).toEqual(['open-tab:workspace:tab-1', 'open-tab:browser:page-1'])
  })

  it('keeps branch matches while excluding worktree and repository fields', () => {
    expect(
      search({
        query: 'main',
        workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Notes' })]
      }).map(readableId)
    ).toEqual(['open-tab:workspace:tab-1'])
  })

  it('uses an admissible title proof when the unrestricted match prefers the worktree', () => {
    const entry = makeWorkspaceTab({ id: 'tab-1', title: 'atlaz' })
    entry.document = buildPaletteTabDocument({
      id: 'tab-1',
      title: 'atlaz',
      secondaryTexts: [],
      worktreeName: 'atlas',
      branch: BRANCH_NAME,
      repoName: REPO_NAME
    })

    expect(search({ query: 'atlas', workspaceTabs: [entry] }).map(readableId)).toEqual([
      'open-tab:workspace:tab-1'
    ])
  })

  it('does not create a snippet fallback when only excluded structured fields match', () => {
    expect(
      search({
        query: 'aurora',
        workspaceTabs: [
          makeWorkspaceTab({
            id: 'tab-1',
            title: 'Notes',
            agentSnippets: ['aurora agent notes']
          })
        ]
      })
    ).toEqual([])
  })

  // Both tokens land on the "ios simulator" alias, so the row fills no title or
  // secondary range — the inverse test would drop it.
  it('keeps a simulator alias match that spans two keywords', () => {
    const results = search({
      query: 'ios sim',
      simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Pixel 8' })]
    })

    expect(results.map(readableId)).toEqual(['open-tab:simulator:sim-1'])
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

  it('keeps editor paths scoped to their host and worktree when tab ids repeat', () => {
    const local = makeWorkspaceTab({
      id: 'same-tab',
      title: 'Atlas',
      contentType: 'editor',
      secondaryText: 'local/atlas.ts'
    })
    const remote = makeWorkspaceTab({
      id: 'same-tab',
      title: 'Atlas',
      contentType: 'editor',
      secondaryText: 'remote/atlas.ts'
    })
    remote.worktree = { ...worktree, hostId: 'ssh:remote' }
    remote.tab = { ...remote.tab, executionHostId: 'ssh:remote' }
    const sibling = makeWorkspaceTab({
      id: 'same-tab',
      title: 'Atlas',
      contentType: 'editor',
      secondaryText: 'sibling/atlas.ts'
    })
    sibling.worktree = { ...worktree, id: 'wt-2' }
    sibling.tab = { ...sibling.tab, worktreeId: 'wt-2' }

    expect(search({ query: 'Atlas', workspaceTabs: [local, remote, sibling] })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionHostId: 'local',
          worktreeId: 'wt-1',
          relativePath: 'local/atlas.ts'
        }),
        expect.objectContaining({
          executionHostId: 'ssh:remote',
          worktreeId: 'wt-1',
          relativePath: 'remote/atlas.ts'
        }),
        expect.objectContaining({
          executionHostId: 'local',
          worktreeId: 'wt-2',
          relativePath: 'sibling/atlas.ts'
        })
      ])
    )
  })

  it('copies a confident occupant agent onto workspace results', () => {
    const results = search({
      query: 'grok',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'grok', occupantAgent: 'grok' })]
    })

    expect(results[0]).toMatchObject({
      source: 'workspace',
      contentType: 'terminal',
      occupantAgent: 'grok'
    })
  })

  it('carries the activation identifiers each source needs', () => {
    const faviconUrl = 'https://example.com/favicon.ico'
    const results = search({
      query: 'zebra',
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Zebra tab' })],
      browserPages: [makeBrowserPage({ id: 'page-1', title: 'Zebra page', faviconUrl })],
      simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Zebra emulator' })]
    })

    expect(results).toMatchObject([
      {
        source: 'workspace',
        contentType: 'terminal',
        tabId: 'tab-1',
        entityId: 'tab-1-entity',
        groupId: 'group-1',
        worktreeId: 'wt-1',
        occupantAgent: null
      },
      {
        source: 'browser',
        contentType: 'browser',
        pageId: 'page-1',
        workspaceId: 'page-1-ws',
        worktreeId: 'wt-1',
        faviconUrl
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

  it('returns nothing once the query passes the matcher token limit', () => {
    const query = Array.from({ length: PALETTE_QUERY_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(' ')

    expect(
      search({
        query,
        workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'Zebra tab' })],
        browserPages: [makeBrowserPage({ id: 'page-1', title: 'Zebra page' })],
        simulatorTabs: [makeSimulatorTab({ id: 'sim-1', label: 'Zebra emulator' })]
      })
    ).toEqual([])
  })

  it('returns nothing for an oversized query instead of searching', () => {
    const results = search({
      query: 'z'.repeat(OPEN_TAB_SEARCH_QUERY_MAX_BYTES + 1),
      workspaceTabs: [makeWorkspaceTab({ id: 'tab-1', title: 'z'.repeat(4096) })]
    })

    expect(results).toEqual([])
  })
})
