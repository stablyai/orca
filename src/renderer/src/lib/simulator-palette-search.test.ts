import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup, Worktree } from '../../../shared/types'
import {
  SIMULATOR_PALETTE_QUERY_MAX_BYTES,
  buildSearchableSimulatorTabs,
  isSimulatorPaletteQueryTooLarge,
  searchSimulatorTabs,
  type SearchableSimulatorTab
} from './simulator-palette-search'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature/mobile-emulator',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Mobile Worktree',
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

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'sim-1',
    entityId: 'sim-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'simulator',
    label: 'Mobile Emulator',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id: 'group-1',
    worktreeId: 'wt-1',
    activeTabId: 'sim-1',
    tabOrder: ['sim-1'],
    ...overrides
  }
}

describe('simulator-palette-search', () => {
  it('keeps empty-query ordering deterministic and context-first', () => {
    const results = searchSimulatorTabs(
      [
        {
          tab: makeTab({ id: 'sim-other', worktreeId: 'wt-other' }),
          worktree: makeWorktree({ id: 'wt-other', displayName: 'Other WT' }),
          repoName: 'repo/other',
          worktreeSortIndex: 2,
          isCurrentTab: false,
          isCurrentWorktree: false
        },
        {
          tab: makeTab({ id: 'sim-current-worktree' }),
          worktree: makeWorktree({ displayName: 'Current WT' }),
          repoName: 'repo/current',
          worktreeSortIndex: 1,
          isCurrentTab: false,
          isCurrentWorktree: true
        },
        {
          tab: makeTab({ id: 'sim-current-tab' }),
          worktree: makeWorktree({ displayName: 'Current WT' }),
          repoName: 'repo/current',
          worktreeSortIndex: 1,
          isCurrentTab: true,
          isCurrentWorktree: true
        }
      ],
      ''
    )

    expect(results.map((result) => result.tabId)).toEqual([
      'sim-current-tab',
      'sim-current-worktree',
      'sim-other'
    ])
  })

  it('matches mobile emulator and simulator aliases', () => {
    const entries = [
      {
        tab: makeTab({ label: 'Phone Preview' }),
        worktree: makeWorktree(),
        repoName: 'repo/mobile',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false
      }
    ]

    expect(searchSimulatorTabs(entries, 'mobile')[0]?.secondaryRange).toEqual({ start: 0, end: 6 })
    expect(searchSimulatorTabs(entries, 'simulator')).toHaveLength(1)
    expect(searchSimulatorTabs(entries, 'ios')).toHaveLength(1)
  })

  it('searches worktree and repo metadata', () => {
    const entries = [
      {
        tab: makeTab({ label: 'Phone Preview' }),
        worktree: makeWorktree({ displayName: 'Checkout Flow' }),
        repoName: 'orca/mobile-client',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false
      }
    ]

    expect(searchSimulatorTabs(entries, 'checkout')[0]?.worktreeRange).toEqual({
      start: 0,
      end: 8
    })
    expect(searchSimulatorTabs(entries, 'client')[0]?.repoRange).toEqual({ start: 12, end: 18 })
  })

  it('marks the current simulator tab from the active unified group', () => {
    const worktree = makeWorktree()
    const entries = buildSearchableSimulatorTabs({
      worktrees: [worktree],
      repoMap: new Map([[worktree.repoId, { displayName: 'repo/mobile' }]]),
      worktreeOrder: new Map([[worktree.id, 0]]),
      unifiedTabsByWorktree: {
        [worktree.id]: [makeTab({ id: 'sim-1', groupId: 'group-sim' })]
      },
      activeGroupIdByWorktree: { [worktree.id]: 'group-sim' },
      groupsByWorktree: {
        [worktree.id]: [makeGroup({ id: 'group-sim', activeTabId: 'sim-1' })]
      },
      activeWorktreeId: worktree.id,
      activeTabType: 'simulator'
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].isCurrentTab).toBe(true)
    expect(searchSimulatorTabs(entries, '')[0]?.score).toBe(-2)
  })

  it('rejects oversized pasted queries before scanning simulator tabs', () => {
    const oversizedQuery = 'secret-simulator-palette'.repeat(SIMULATOR_PALETTE_QUERY_MAX_BYTES)
    const entry = {
      get tab(): Tab {
        throw new Error('oversized simulator palette queries must not scan tabs')
      },
      worktree: makeWorktree(),
      repoName: 'repo/mobile',
      worktreeSortIndex: 0,
      isCurrentTab: false,
      isCurrentWorktree: false
    } as SearchableSimulatorTab

    expect(isSimulatorPaletteQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchSimulatorTabs([entry], oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming simulator palette queries', () => {
    expect(searchSimulatorTabs([], ' '.repeat(SIMULATOR_PALETTE_QUERY_MAX_BYTES + 1))).toEqual([])
  })
})
