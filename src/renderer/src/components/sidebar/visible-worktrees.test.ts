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

const repoMap = new Map<string, Repo>([
  [
    'repo1',
    {
      id: 'repo1',
      path: '/repo1',
      displayName: 'Repo 1',
      badgeColor: '#000',
      addedAt: 0
    }
  ],
  [
    'repo2',
    {
      id: 'repo2',
      path: '/repo2',
      displayName: 'Repo 2',
      badgeColor: '#111',
      addedAt: 0
    }
  ]
])

describe('computeVisibleWorktreeIds', () => {
  it('treats browser-tab worktrees as active for the active-only filter', () => {
    const wt = makeWorktree('wt-browser')

    const result = computeVisibleWorktreeIds({ repo1: [wt] }, [wt.id], {
      filterRepoIds: [],
      showActiveOnly: true,
      tabsByWorktree: {},
      browserTabsByWorktree: { [wt.id]: [{ id: 'browser-1' }] },
      activeWorktreeId: null,
      hideDefaultBranchWorkspace: false,
      repoMap
    })

    expect(result).toEqual([wt.id])
  })

  it('keeps the currently active worktree visible even without PTYs', () => {
    const wt = makeWorktree('wt-active')

    const result = computeVisibleWorktreeIds({ repo1: [wt] }, [wt.id], {
      filterRepoIds: [],
      showActiveOnly: true,
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      activeWorktreeId: wt.id,
      hideDefaultBranchWorkspace: false,
      repoMap
    })

    expect(result).toEqual([wt.id])
  })

  it('hides branch-backed main worktrees when default branch workspaces are hidden', () => {
    const main = makeWorktree('main')
    const feature = makeWorktree('feature')
    main.isMainWorktree = true

    const result = computeVisibleWorktreeIds({ repo1: [main, feature] }, [main.id, feature.id], {
      filterRepoIds: [],
      showActiveOnly: false,
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      activeWorktreeId: main.id,
      hideDefaultBranchWorkspace: true,
      repoMap
    })

    expect(result).toEqual([feature.id])
  })

  it('keeps folder-mode main worktrees visible when default branch workspaces are hidden', () => {
    const folder = makeWorktree('folder')
    folder.isMainWorktree = true
    folder.branch = ''

    const result = computeVisibleWorktreeIds({ repo1: [folder] }, [folder.id], {
      filterRepoIds: [],
      showActiveOnly: false,
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      activeWorktreeId: null,
      hideDefaultBranchWorkspace: true,
      repoMap
    })

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
      {
        filterRepoIds: [],
        showActiveOnly: false,
        tabsByWorktree: {},
        browserTabsByWorktree: {},
        activeWorktreeId: null,
        hideDefaultBranchWorkspace: true,
        repoMap
      }
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
    const result = computeVisibleWorktreeIds({ repo1: [main, feature] }, [main.id, feature.id], {
      filterRepoIds: [],
      showActiveOnly: true,
      tabsByWorktree: { [feature.id]: [makeTab('t1', feature.id, 'p1')] },
      browserTabsByWorktree: {},
      activeWorktreeId: main.id,
      hideDefaultBranchWorkspace: true,
      repoMap
    })

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
      {
        filterRepoIds: ['repo2'],
        showActiveOnly: false,
        tabsByWorktree: {},
        browserTabsByWorktree: {},
        activeWorktreeId: null,
        hideDefaultBranchWorkspace: true,
        repoMap
      }
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
    expect(
      sidebarHasActiveFilters({
        showActiveOnly: false,
        filterRepoIds: [],
        hideDefaultBranchWorkspace: false
      })
    ).toBe(false)
  })

  it('returns true when only hideDefaultBranchWorkspace is active', () => {
    // Why: regression guard for the empty-sidebar escape hatch. If hide is
    // omitted from the filter union, a user whose only worktree is the
    // default-branch row sees "No worktrees found" with no way back.
    expect(
      sidebarHasActiveFilters({
        showActiveOnly: false,
        filterRepoIds: [],
        hideDefaultBranchWorkspace: true
      })
    ).toBe(true)
  })

  it('returns true when only showActiveOnly is active', () => {
    expect(
      sidebarHasActiveFilters({
        showActiveOnly: true,
        filterRepoIds: [],
        hideDefaultBranchWorkspace: false
      })
    ).toBe(true)
  })

  it('returns true when only filterRepoIds is non-empty', () => {
    expect(
      sidebarHasActiveFilters({
        showActiveOnly: false,
        filterRepoIds: ['repo1'],
        hideDefaultBranchWorkspace: false
      })
    ).toBe(true)
  })
})

describe('computeClearFilterActions', () => {
  it('returns no-op actions when nothing is set', () => {
    expect(
      computeClearFilterActions({
        showActiveOnly: false,
        filterRepoIds: [],
        hideDefaultBranchWorkspace: false
      })
    ).toEqual({
      resetShowActiveOnly: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false
    })
  })

  it('flags only hideDefaultBranchWorkspace for reset when it is the sole filter', () => {
    // Why: verifies the empty-sidebar escape hatch actually clears the hide
    // flag. A regression here would leave users stuck on "No worktrees found"
    // because the only active filter would never clear.
    expect(
      computeClearFilterActions({
        showActiveOnly: false,
        filterRepoIds: [],
        hideDefaultBranchWorkspace: true
      })
    ).toEqual({
      resetShowActiveOnly: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: true
    })
  })

  it('does not flag hideDefaultBranchWorkspace when it is already off', () => {
    // Why: avoids issuing a pointless IPC write on every Clear Filters click
    // in the common case where hide was never on.
    const actions = computeClearFilterActions({
      showActiveOnly: true,
      filterRepoIds: ['repo1'],
      hideDefaultBranchWorkspace: false
    })
    expect(actions.resetHideDefaultBranchWorkspace).toBe(false)
    expect(actions.resetShowActiveOnly).toBe(true)
    expect(actions.resetFilterRepoIds).toBe(true)
  })

  it('flags every active filter simultaneously', () => {
    expect(
      computeClearFilterActions({
        showActiveOnly: true,
        filterRepoIds: ['repo1', 'repo2'],
        hideDefaultBranchWorkspace: true
      })
    ).toEqual({
      resetShowActiveOnly: true,
      resetFilterRepoIds: true,
      resetHideDefaultBranchWorkspace: true
    })
  })
})
