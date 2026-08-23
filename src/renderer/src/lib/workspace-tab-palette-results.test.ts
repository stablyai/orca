import { describe, expect, it } from 'vitest'
import type { Tab, TabContentType } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { buildPaletteTabDocument } from './palette-match/tab-document'
import { searchWorkspaceTabs } from './workspace-tab-palette-results'
import type { SearchableWorkspaceTab } from './workspace-tab-palette-search'

const REPO_NAME = 'octo/rocket'
const WORKTREE_NAME = 'Aurora Workspace'
const BRANCH_NAME = 'main'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: WORKTREE_NAME,
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

function makeTab(id: string, contentType: TabContentType, createdAt: number): Tab {
  return {
    id,
    entityId: `${id}-entity`,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

function makeEntry({
  id = 'tab-1',
  contentType = 'terminal',
  createdAt = 0,
  worktree = makeWorktree(),
  agentLastActivityAt
}: {
  id?: string
  contentType?: 'terminal' | 'editor'
  createdAt?: number
  worktree?: Worktree
  agentLastActivityAt?: number
} = {}): SearchableWorkspaceTab {
  const title = id
  return {
    tab: makeTab(id, contentType, createdAt) as SearchableWorkspaceTab['tab'],
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    groupSortIndex: 0,
    tabSortIndex: 0,
    occupantAgent: null,
    title,
    secondaryText: '',
    titleSearchText: title,
    secondarySearchTexts: [],
    document: buildPaletteTabDocument({
      id,
      title,
      secondaryTexts: [],
      worktreeName: WORKTREE_NAME,
      branch: BRANCH_NAME,
      repoName: REPO_NAME
    }),
    agentMetadata:
      agentLastActivityAt === undefined
        ? []
        : [
            {
              paneKey: `${id}-pane`,
              textParts: [],
              snippetCandidates: [],
              lastActivityAt: agentLastActivityAt
            }
          ],
    isCurrentTab: false,
    isCurrentWorktree: true
  }
}

describe('searchWorkspaceTabs lastActiveAt', () => {
  it('is null when neither agent activity nor worktree activity is known', () => {
    const [result] = searchWorkspaceTabs([makeEntry()], '')
    expect(result.lastActiveAt).toBeNull()
  })

  it('falls back to worktree PTY activity for editor tabs with no agent metadata', () => {
    const entry = makeEntry({
      contentType: 'editor',
      worktree: makeWorktree({ lastActivityAt: 5000 })
    })
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(5000)
  })

  it('prefers agent activity over worktree activity when agent activity is newer', () => {
    const entry = makeEntry({
      worktree: makeWorktree({ lastActivityAt: 1000 }),
      agentLastActivityAt: 9000
    })
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(9000)
  })

  it('prefers agent activity even when it is older than worktree activity', () => {
    const entry = makeEntry({
      worktree: makeWorktree({ lastActivityAt: 9000 }),
      agentLastActivityAt: 1000
    })
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(1000)
  })

  it('clamps to the tab creation time when the activity signal predates it', () => {
    const entry = makeEntry({
      createdAt: 4000,
      worktree: makeWorktree({ lastActivityAt: 1000 })
    })
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(4000)
  })

  it('uses tab lastFocusedAt when no agent metadata is present', () => {
    const entry = makeEntry({
      id: 'tab-focused',
      createdAt: 1000
    })
    entry.tab.lastFocusedAt = 6000
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(6000)
  })
})

describe('searchWorkspaceTabs ranking', () => {
  it('ranks direct tab title matches ahead of container-only worktree matches', () => {
    const directEntry = makeEntry({ id: 'README-4360' })
    const containerEntry = makeEntry({ id: 'unrelated-file' })
    // Both are in WORKTREE_NAME 'Aurora Workspace', but suppose worktree has 4360
    directEntry.document = buildPaletteTabDocument({
      id: 'tab-direct',
      title: 'STA-4360-fix.ts',
      secondaryTexts: [],
      worktreeName: 'STA-4360',
      branch: 'main',
      repoName: 'repo'
    })
    containerEntry.document = buildPaletteTabDocument({
      id: 'tab-container',
      title: 'other-file.ts',
      secondaryTexts: [],
      worktreeName: 'STA-4360',
      branch: 'main',
      repoName: 'repo'
    })

    const results = searchWorkspaceTabs([containerEntry, directEntry], '4360')
    expect(results).toHaveLength(2)
    expect(results[0].tabId).toBe('README-4360')
    expect(results[0].rank?.matchedDirectField).toBe(0)
    expect(results[1].tabId).toBe('unrelated-file')
    expect(results[1].rank?.matchedDirectField).toBe(1)
  })

  it('breaks tie between two container-matching tabs using lastActiveAt recency', () => {
    const olderTab = makeEntry({ id: 'older-tab' })
    const newerTab = makeEntry({ id: 'newer-tab' })
    olderTab.document = buildPaletteTabDocument({
      id: 'older',
      title: 'file-a.ts',
      secondaryTexts: [],
      worktreeName: 'STA-4360',
      branch: 'main',
      repoName: 'repo'
    })
    newerTab.document = buildPaletteTabDocument({
      id: 'newer',
      title: 'file-b.ts',
      secondaryTexts: [],
      worktreeName: 'STA-4360',
      branch: 'main',
      repoName: 'repo'
    })
    olderTab.tab.lastFocusedAt = 1000
    newerTab.tab.lastFocusedAt = 5000

    const results = searchWorkspaceTabs([olderTab, newerTab], '4360')
    expect(results).toHaveLength(2)
    expect(results[0].tabId).toBe('newer-tab')
    expect(results[1].tabId).toBe('older-tab')
  })
})
