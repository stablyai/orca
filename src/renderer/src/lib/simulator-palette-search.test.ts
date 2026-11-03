import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { buildPaletteTabDocument } from '../../../shared/palette-match/tab-document'
import '../../../shared/palette-match/palette-query'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import {
  SIMULATOR_PALETTE_QUERY_MAX_BYTES,
  SIMULATOR_TYPE_SEARCH_ALIASES,
  buildSearchableSimulatorTabs,
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

describe('simulator-palette-search lastActiveAt', () => {
  function entryFor(overrides: Partial<Tab>): SearchableSimulatorTab {
    return makeEntry({
      tab: makeTab(overrides),
      worktree: makeWorktree(),
      repoName: 'repo/mobile',
      worktreeSortIndex: 0,
      isCurrentTab: false,
      isCurrentWorktree: true
    })
  }

  it('breaks a rank tie between equally-matching tabs by recency', () => {
    // Ids are ordered so an id-only tiebreak would flip this expectation.
    const older = entryFor({ id: 'sim-a-older', lastFocusedAt: 1000 })
    const newer = entryFor({ id: 'sim-z-newer', lastFocusedAt: 5000 })

    const results = searchSimulatorTabs([older, newer], 'emulator')

    expect(results.map((result) => result.tabId)).toEqual(['sim-z-newer', 'sim-a-older'])
  })
})

describe('simulator-palette-search', () => {
  it('keeps same-id simulator tabs isolated by execution host', () => {
    const sharedId = 'repo-shared::/workspace'
    const local = makeWorktree({ id: sharedId, hostId: 'local', displayName: 'Local workspace' })
    const remote = makeWorktree({
      id: sharedId,
      hostId: 'runtime:host-b',
      displayName: 'Remote workspace'
    })
    const entries = buildSearchableSimulatorTabs({
      worktrees: [local, remote],
      repoMap: new Map([[local.repoId, { displayName: 'repo/mobile' }]]),
      worktreeOrder: new Map([
        [getWorktreeHostIdentity(local), 0],
        [getWorktreeHostIdentity(remote), 1]
      ]),
      unifiedTabsByWorktree: {
        [sharedId]: [
          makeTab({
            id: 'sim-local',
            worktreeId: sharedId,
            executionHostId: 'local',
            label: 'Local emulator'
          }),
          makeTab({
            id: 'sim-remote',
            worktreeId: sharedId,
            executionHostId: 'runtime:host-b',
            label: 'Remote emulator'
          })
        ]
      },
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      activeWorktreeId: null,
      activeTabType: 'terminal'
    })

    expect(entries.map((entry) => [entry.tab.id, entry.worktree.hostId])).toEqual([
      ['sim-local', 'local'],
      ['sim-remote', 'runtime:host-b']
    ])
    expect(
      searchSimulatorTabs(entries, 'emulator').map((result) => [
        result.tabId,
        result.executionHostId
      ])
    ).toEqual([
      ['sim-local', 'local'],
      ['sim-remote', 'runtime:host-b']
    ])
  })

  it('does not route one ambiguous legacy simulator bucket to both hosts', () => {
    const sharedId = 'repo-shared::/workspace'
    const entries = buildSearchableSimulatorTabs({
      worktrees: [
        makeWorktree({ id: sharedId, hostId: 'local' }),
        makeWorktree({ id: sharedId, hostId: 'runtime:host-b' })
      ],
      repoMap: new Map(),
      worktreeOrder: new Map(),
      unifiedTabsByWorktree: {
        [sharedId]: [makeTab({ worktreeId: sharedId })]
      },
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      activeWorktreeId: null,
      activeTabType: 'terminal'
    })

    expect(entries).toEqual([])
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

    expect(searchSimulatorTabs([entry], oversizedQuery)).toEqual([])
  })
})
