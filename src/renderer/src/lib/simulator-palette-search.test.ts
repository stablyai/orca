import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { buildPaletteTabDocument } from './palette-match/tab-document'
import { PALETTE_QUERY_MAX_TOKENS } from './palette-match/palette-query'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import {
  SIMULATOR_PALETTE_QUERY_MAX_BYTES,
  SIMULATOR_TYPE_SEARCH_ALIASES,
  buildSearchableSimulatorTabs,
  isSimulatorPaletteQueryTooLarge,
  searchSimulatorTabs,
  simulatorPaletteTabTitle,
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

/** Mirrors buildSearchableSimulatorTabs so hand-built rows index the same fields. */
function makeEntry(entry: Omit<SearchableSimulatorTab, 'document'>): SearchableSimulatorTab {
  return {
    ...entry,
    document: buildPaletteTabDocument({
      id: entry.tab.id,
      title: simulatorPaletteTabTitle(entry.tab),
      secondaryTexts: [],
      worktreeName: resolveWorktreeDisplayName(entry.worktree),
      branch: resolveWorktreeBranchLabel(entry.worktree),
      repoName: entry.repoName,
      typeAliases: SIMULATOR_TYPE_SEARCH_ALIASES
    })
  }
}

describe('simulator-palette-search', () => {
  it('keeps empty-query ordering deterministic and context-first', () => {
    const results = searchSimulatorTabs(
      [
        makeEntry({
          tab: makeTab({ id: 'sim-other', worktreeId: 'wt-other' }),
          worktree: makeWorktree({ id: 'wt-other', displayName: 'Other WT' }),
          repoName: 'repo/other',
          worktreeSortIndex: 2,
          isCurrentTab: false,
          isCurrentWorktree: false
        }),
        makeEntry({
          tab: makeTab({ id: 'sim-current-worktree' }),
          worktree: makeWorktree({ displayName: 'Current WT' }),
          repoName: 'repo/current',
          worktreeSortIndex: 1,
          isCurrentTab: false,
          isCurrentWorktree: true
        }),
        makeEntry({
          tab: makeTab({ id: 'sim-current-tab' }),
          worktree: makeWorktree({ displayName: 'Current WT' }),
          repoName: 'repo/current',
          worktreeSortIndex: 1,
          isCurrentTab: true,
          isCurrentWorktree: true
        })
      ],
      ''
    )

    expect(results.map((result) => result.tabId)).toEqual([
      'sim-current-tab',
      'sim-current-worktree',
      'sim-other'
    ])
  })

  it('stamps each row with its own execution host when worktree ids collide', () => {
    // Two hosts can serve the same worktree id, so activation needs the host
    // that owns the row rather than the first id match in the store.
    const entries = [
      makeEntry({
        tab: makeTab({ id: 'sim-local' }),
        worktree: makeWorktree(),
        repoName: 'repo/mobile',
        worktreeSortIndex: 0,
        isCurrentTab: false,
        isCurrentWorktree: false
      }),
      makeEntry({
        tab: makeTab({ id: 'sim-remote' }),
        worktree: makeWorktree({ hostId: 'ssh:host-1' }),
        repoName: 'repo/mobile',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false
      })
    ]

    expect(
      searchSimulatorTabs(entries, 'emulator').map((result) => [
        result.tabId,
        result.worktreeId,
        result.executionHostId
      ])
    ).toEqual([
      ['sim-local', 'wt-1', undefined],
      ['sim-remote', 'wt-1', 'ssh:host-1']
    ])
  })

  it('matches mobile emulator and simulator aliases', () => {
    // Worktree/branch/repo are alias-free so only the alias fields can produce a hit.
    const entries = [
      makeEntry({
        tab: makeTab({ label: 'Phone Preview' }),
        worktree: makeWorktree({ displayName: 'Checkout Flow', branch: 'refs/heads/main' }),
        repoName: 'repo/shop',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false
      })
    ]

    // Why no secondaryRanges: type aliases match without a display secondary.
    const mobileHit = searchSimulatorTabs(entries, 'mobile')[0]
    expect(mobileHit?.secondaryText).toBe('')
    expect(mobileHit?.secondaryRanges).toEqual([])
    // Ranges index the alias string, not the row.
    expect(mobileHit?.typeAliasMatch).toEqual({
      text: 'mobile emulator tab',
      ranges: [{ start: 0, end: 6 }]
    })
    expect(searchSimulatorTabs(entries, 'simulator')).toHaveLength(1)
    expect(searchSimulatorTabs(entries, 'ios')).toHaveLength(1)
    // Why: "emulator" equals the standalone alias, which outranks the phrase aliases.
    expect(searchSimulatorTabs(entries, 'emulator')[0]?.typeAliasMatch).toEqual({
      text: 'emulator',
      ranges: [{ start: 0, end: 8 }]
    })
  })

  it('matches an alias keyword together with the worktree name', () => {
    const entries = [
      makeEntry({
        tab: makeTab({ label: 'Phone Preview' }),
        worktree: makeWorktree({ displayName: 'Checkout Flow', branch: 'refs/heads/main' }),
        repoName: 'repo/shop',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false
      })
    ]

    const hit = searchSimulatorTabs(entries, 'emulator checkout')[0]
    expect(hit?.typeAliasMatch).toEqual({ text: 'emulator', ranges: [{ start: 0, end: 8 }] })
    expect(hit?.worktreeRanges).toEqual([{ start: 0, end: 8 }])
  })

  it('drops a row when only one token of a multi-keyword query lands', () => {
    const entries = [
      makeEntry({
        tab: makeTab({ label: 'Phone Preview' }),
        worktree: makeWorktree({ displayName: 'Checkout Flow', branch: 'refs/heads/main' }),
        repoName: 'repo/shop',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false
      })
    ]

    expect(searchSimulatorTabs(entries, 'emulator zzzznonexistent')).toEqual([])
  })

  it('searches worktree and repo metadata', () => {
    const entries = [
      makeEntry({
        tab: makeTab({ label: 'Phone Preview' }),
        worktree: makeWorktree({ displayName: 'Checkout Flow' }),
        repoName: 'orca/mobile-client',
        worktreeSortIndex: 1,
        isCurrentTab: false,
        isCurrentWorktree: false
      })
    ]

    expect(searchSimulatorTabs(entries, 'checkout')[0]?.worktreeRanges).toEqual([
      { start: 0, end: 8 }
    ])
    expect(searchSimulatorTabs(entries, 'client')[0]?.repoRanges).toEqual([{ start: 12, end: 18 }])
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
    expect(searchSimulatorTabs(entries, '')[0]?.score).toBe(-4000)
  })

  it('rejects a query with more unique tokens than the matcher accepts', () => {
    const query = Array.from({ length: PALETTE_QUERY_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(' ')
    const entries = [
      makeEntry({
        tab: makeTab(),
        worktree: makeWorktree(),
        repoName: 'repo/mobile',
        worktreeSortIndex: 0,
        isCurrentTab: false,
        isCurrentWorktree: false
      })
    ]

    expect(searchSimulatorTabs(entries, query)).toEqual([])
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
      isCurrentWorktree: false,
      document: buildPaletteTabDocument({
        id: 'sim-1',
        title: 'Mobile Emulator',
        secondaryTexts: [],
        worktreeName: 'Mobile Worktree',
        branch: 'feature/mobile-emulator',
        repoName: 'repo/mobile',
        typeAliases: SIMULATOR_TYPE_SEARCH_ALIASES
      })
    } as SearchableSimulatorTab

    expect(isSimulatorPaletteQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchSimulatorTabs([entry], oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming simulator palette queries', () => {
    expect(searchSimulatorTabs([], ' '.repeat(SIMULATOR_PALETTE_QUERY_MAX_BYTES + 1))).toEqual([])
  })

  it('falls back to the branch label when a cleared display name left it undefined', () => {
    // Why: Cmd+J runs this search over the same worktree objects as searchWorktrees,
    // so the store-level display-name corruption reaches here too.
    const entries = [
      makeEntry({
        tab: makeTab(),
        worktree: makeWorktree({
          displayName: undefined as unknown as string,
          branch: 'refs/heads/feature/mobile-emulator'
        }),
        repoName: 'orca',
        worktreeSortIndex: 0,
        isCurrentTab: false,
        isCurrentWorktree: false
      })
    ]

    expect(searchSimulatorTabs(entries, 'mobile-emulator')[0]).toMatchObject({
      worktreeName: 'feature/mobile-emulator',
      worktreeRanges: [{ start: 'feature/'.length, end: 'feature/mobile-emulator'.length }]
    })
  })

  it('lists a branch-less row on the empty query without throwing', () => {
    const entries = [
      makeEntry({
        tab: makeTab(),
        worktree: makeWorktree({
          displayName: undefined as unknown as string,
          branch: undefined as unknown as string,
          path: '/repos/design-review'
        }),
        repoName: 'orca',
        worktreeSortIndex: 0,
        isCurrentTab: false,
        isCurrentWorktree: false
      })
    ]

    expect(searchSimulatorTabs(entries, '')[0]).toMatchObject({
      worktreeName: 'design-review',
      worktreeRanges: []
    })
  })
})
