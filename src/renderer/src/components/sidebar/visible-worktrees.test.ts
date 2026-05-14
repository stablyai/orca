/* eslint-disable max-lines */
import { describe, expect, it } from 'vitest'
import {
  computeClearFilterActions,
  computeVisibleWorktreeIds,
  isDefaultBranchWorkspace,
  sidebarHasActiveFilters
} from './visible-worktrees'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'

function makeTab(id: string, worktreeId: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeWorktree(id: string, repoId = 'repo1'): Worktree {
  return {
    id,
    repoId,
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
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
}

function makeRepo(id: string, displayName: string, badgeColor: string): Repo {
  return { id, path: `/${id}`, displayName, badgeColor, addedAt: 0 }
}

const repoMap = new Map<string, Repo>([
  ['repo1', makeRepo('repo1', 'Repo 1', '#000')],
  ['repo2', makeRepo('repo2', 'Repo 2', '#111')]
])

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

function visibleOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    showActiveOnly: false,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    activeWorktreeId: null,
    hideDefaultBranchWorkspace: false,
    repoMap,
    ...overrides
  }
}

type FilterState = Parameters<typeof sidebarHasActiveFilters>[0]

function filterState(overrides: Partial<FilterState> = {}): FilterState {
  return {
    showActiveOnly: false,
    filterRepoIds: [],
    hideDefaultBranchWorkspace: false,
    ...overrides
  }
}

describe('computeVisibleWorktreeIds', () => {
  it('treats browser-tab worktrees as active for the active-only filter', () => {
    const wt = makeWorktree('wt-browser')

    const result = computeVisibleWorktreeIds(
      { repo1: [wt] },
      [wt.id],
      visibleOptions({
        showActiveOnly: true,
        browserTabsByWorktree: { [wt.id]: [{ id: 'browser-1' }] }
      })
    )

    expect(result).toEqual([wt.id])
  })

  it('keeps the currently active worktree visible even without PTYs', () => {
    const wt = makeWorktree('wt-active')

    const result = computeVisibleWorktreeIds(
      { repo1: [wt] },
      [wt.id],
      visibleOptions({
        showActiveOnly: true,
        activeWorktreeId: wt.id
      })
    )

    expect(result).toEqual([wt.id])
  })

  it('does not treat slept wake-hint tabs as active terminals', () => {
    const wt = makeWorktree('wt-slept')

    const result = computeVisibleWorktreeIds(
      { repo1: [wt] },
      [wt.id],
      visibleOptions({
        showActiveOnly: true,
        tabsByWorktree: { [wt.id]: [makeTab('tab-slept', wt.id, 'wake-hint-session')] },
        // Sleep preserves tab.ptyId as the wake hint but clears live PTY ids.
        ptyIdsByTabId: { 'tab-slept': [] }
      })
    )

    expect(result).toEqual([])
  })

  it('hides branch-backed main worktrees when default branch workspaces are hidden', () => {
    const main = makeWorktree('main')
    const feature = makeWorktree('feature')
    main.isMainWorktree = true

    const result = computeVisibleWorktreeIds(
      { repo1: [main, feature] },
      [main.id, feature.id],
      visibleOptions({
        activeWorktreeId: main.id,
        hideDefaultBranchWorkspace: true
      })
    )

    expect(result).toEqual([feature.id])
  })

  it('keeps folder-mode main worktrees visible when default branch workspaces are hidden', () => {
    const folder = makeWorktree('folder')
    folder.isMainWorktree = true
    folder.branch = ''

    const result = computeVisibleWorktreeIds(
      { repo1: [folder] },
      [folder.id],
      visibleOptions({ hideDefaultBranchWorkspace: true })
    )

    expect(result).toEqual([folder.id])
  })

  it('hides branch-backed mains across every repo in a multi-repo workspace', () => {
    const main1 = makeWorktree('main1', 'repo1')
    main1.isMainWorktree = true
    const feature1 = makeWorktree('feature1', 'repo1')
    const main2 = makeWorktree('main2', 'repo2')
    main2.isMainWorktree = true
    const feature2 = makeWorktree('feature2', 'repo2')

    const result = computeVisibleWorktreeIds(
      { repo1: [main1, feature1], repo2: [main2, feature2] },
      [main1.id, feature1.id, main2.id, feature2.id],
      visibleOptions({ hideDefaultBranchWorkspace: true })
    )

    expect(result).toEqual([feature1.id, feature2.id])
  })

  it('composes with showActiveOnly: the hidden main is dropped even if it is the active worktree', () => {
    const main = makeWorktree('main')
    main.isMainWorktree = true
    const feature = makeWorktree('feature')

    // Why: verifies filter ordering — hide runs before showActiveOnly, so
    // main doesn't slip back in via the "active worktree is always visible"
    // exception that showActiveOnly grants. Feature stays because it has a
    // live PTY.
    const result = computeVisibleWorktreeIds(
      { repo1: [main, feature] },
      [main.id, feature.id],
      visibleOptions({
        showActiveOnly: true,
        tabsByWorktree: { [feature.id]: [makeTab('t1', feature.id, 'p1')] },
        ptyIdsByTabId: { t1: ['p1'] },
        activeWorktreeId: main.id,
        hideDefaultBranchWorkspace: true
      })
    )

    expect(result).toEqual([feature.id])
  })

  it('composes with filterRepoIds: hides mains only within the selected repos', () => {
    const main1 = makeWorktree('main1', 'repo1')
    main1.isMainWorktree = true
    const feature1 = makeWorktree('feature1', 'repo1')
    const main2 = makeWorktree('main2', 'repo2')
    main2.isMainWorktree = true
    const feature2 = makeWorktree('feature2', 'repo2')

    // Why: the filterRepoIds=['repo1'] already drops everything in repo2, so
    // to actually prove the hide filter is scoped to the selected repos we
    // need to flip the situation — select repo2 instead. Only main2 should be
    // dropped by hide; main1 survives because the repo filter has already
    // removed it from consideration.
    const result = computeVisibleWorktreeIds(
      { repo1: [main1, feature1], repo2: [main2, feature2] },
      [main1.id, feature1.id, main2.id, feature2.id],
      visibleOptions({
        filterRepoIds: ['repo2'],
        hideDefaultBranchWorkspace: true
      })
    )

    expect(result).toEqual([feature2.id])
  })
})

describe('isDefaultBranchWorkspace', () => {
  it('returns true for a branch-backed main worktree', () => {
    const main = makeWorktree('main')
    main.isMainWorktree = true
    expect(isDefaultBranchWorkspace(main)).toBe(true)
  })

  it('returns false for folder-mode main worktrees (empty branch)', () => {
    const folder = makeWorktree('folder')
    folder.isMainWorktree = true
    folder.branch = ''
    expect(isDefaultBranchWorkspace(folder)).toBe(false)
  })

  it('returns false for non-main worktrees even on the default branch', () => {
    const feature = makeWorktree('feature')
    expect(isDefaultBranchWorkspace(feature)).toBe(false)
  })
})

describe('sidebarHasActiveFilters', () => {
  it('returns false when no filters are active', () => {
    expect(sidebarHasActiveFilters(filterState())).toBe(false)
  })

  it('returns true when only hideDefaultBranchWorkspace is active', () => {
    // Why: regression guard for the empty-sidebar escape hatch. If hide is
    // omitted from the filter union, a user whose only worktree is the
    // default-branch row sees "No worktrees found" with no way back.
    expect(sidebarHasActiveFilters(filterState({ hideDefaultBranchWorkspace: true }))).toBe(true)
  })

  it('returns true when only showActiveOnly is active', () => {
    expect(sidebarHasActiveFilters(filterState({ showActiveOnly: true }))).toBe(true)
  })

  it('returns true when only filterRepoIds is non-empty', () => {
    expect(sidebarHasActiveFilters(filterState({ filterRepoIds: ['repo1'] }))).toBe(true)
  })
})

describe('computeClearFilterActions', () => {
  it('returns no-op actions when nothing is set', () => {
    expect(computeClearFilterActions(filterState())).toEqual({
      resetShowActiveOnly: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false
    })
  })

  it('flags only hideDefaultBranchWorkspace for reset when it is the sole filter', () => {
    // Why: verifies the empty-sidebar escape hatch actually clears the hide
    // flag. A regression here would leave users stuck on "No worktrees found"
    // because the only active filter would never clear.
    expect(computeClearFilterActions(filterState({ hideDefaultBranchWorkspace: true }))).toEqual({
      resetShowActiveOnly: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: true
    })
  })

  it('does not flag hideDefaultBranchWorkspace when it is already off', () => {
    // Why: avoids issuing a pointless IPC write on every Clear Filters click
    // in the common case where hide was never on.
    const actions = computeClearFilterActions(
      filterState({
        showActiveOnly: true,
        filterRepoIds: ['repo1']
      })
    )
    expect(actions.resetHideDefaultBranchWorkspace).toBe(false)
    expect(actions.resetShowActiveOnly).toBe(true)
    expect(actions.resetFilterRepoIds).toBe(true)
  })

  it('flags every active filter simultaneously', () => {
    expect(
      computeClearFilterActions(
        filterState({
          showActiveOnly: true,
          filterRepoIds: ['repo1', 'repo2'],
          hideDefaultBranchWorkspace: true
        })
      )
    ).toEqual({
      resetShowActiveOnly: true,
      resetFilterRepoIds: true,
      resetHideDefaultBranchWorkspace: true
    })
  })
})
