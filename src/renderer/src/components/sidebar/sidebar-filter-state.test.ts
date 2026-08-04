import { describe, expect, it } from 'vitest'
import {
  computeClearFilterActions,
  isDefaultBranchWorkspace,
  sidebarHasActiveFilters
} from './visible-worktrees'
import type { Worktree } from '../../../../shared/types'

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

type FilterState = Parameters<typeof sidebarHasActiveFilters>[0]

function filterState(overrides: Partial<FilterState> = {}): FilterState {
  return {
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    alwaysShowDefaultBranchWorkspace: true,
    workspaceHostScope: 'all',
    ...overrides
  }
}

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
    // default-branch row sees "No workspaces found" with no way back.
    expect(sidebarHasActiveFilters(filterState({ hideDefaultBranchWorkspace: true }))).toBe(true)
  })

  it('returns true when only automation-created workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideAutomationGeneratedWorkspaces: true }))).toBe(
      true
    )
  })

  it('returns true when only CLI-created workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideCliCreatedWorkspaces: true }))).toBe(true)
  })

  it('returns true when only detached-HEAD workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideDetachedHeadWorkspaces: true }))).toBe(true)
  })

  it('returns true when sleeping workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ showSleepingWorkspaces: false }))).toBe(true)
  })

  it('returns true when only filterRepoIds is non-empty', () => {
    expect(sidebarHasActiveFilters(filterState({ filterRepoIds: ['repo1'] }))).toBe(true)
  })

  it('counts an opted-out default-branch exemption as an active filter', () => {
    expect(sidebarHasActiveFilters(filterState({ alwaysShowDefaultBranchWorkspace: false }))).toBe(
      true
    )
  })

  it('treats a missing default-branch exemption as the default, not a filter', () => {
    const { alwaysShowDefaultBranchWorkspace: _omitted, ...withoutFlag } = filterState()
    expect(sidebarHasActiveFilters(withoutFlag)).toBe(false)
  })

  it('returns true when only host visibility is narrowed', () => {
    expect(sidebarHasActiveFilters(filterState({ visibleWorkspaceHostIds: ['local'] }))).toBe(true)
  })
})

describe('computeClearFilterActions', () => {
  it('returns no-op actions when nothing is set', () => {
    expect(computeClearFilterActions(filterState())).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetAlwaysShowDefaultBranchWorkspace: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags only hideDefaultBranchWorkspace for reset when it is the sole filter', () => {
    // Why: verifies the empty-sidebar escape hatch actually clears the hide
    // flag. A regression here would leave users stuck on "No workspaces found"
    // because the only active filter would never clear.
    expect(computeClearFilterActions(filterState({ hideDefaultBranchWorkspace: true }))).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: true,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetAlwaysShowDefaultBranchWorkspace: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags only hideAutomationGeneratedWorkspaces for reset when it is the sole filter', () => {
    expect(
      computeClearFilterActions(filterState({ hideAutomationGeneratedWorkspaces: true }))
    ).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: true,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetAlwaysShowDefaultBranchWorkspace: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags only hideCliCreatedWorkspaces for reset when it is the sole filter', () => {
    expect(computeClearFilterActions(filterState({ hideCliCreatedWorkspaces: true }))).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: true,
      resetHideDetachedHeadWorkspaces: false,
      resetAlwaysShowDefaultBranchWorkspace: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags only hideDetachedHeadWorkspaces for reset when it is the sole filter', () => {
    expect(computeClearFilterActions(filterState({ hideDetachedHeadWorkspaces: true }))).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: true,
      resetAlwaysShowDefaultBranchWorkspace: false,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('does not flag hideDefaultBranchWorkspace when it is already off', () => {
    // Why: avoids issuing a pointless IPC write on every Clear Filters click
    // in the common case where hide was never on.
    const actions = computeClearFilterActions(
      filterState({
        filterRepoIds: ['repo1']
      })
    )
    expect(actions.resetHideDefaultBranchWorkspace).toBe(false)
    expect(actions.resetShowSleepingWorkspaces).toBe(false)
    expect(actions.resetFilterRepoIds).toBe(true)
  })

  it('flags legacy single-host scope for reset even without visible host ids', () => {
    expect(computeClearFilterActions(filterState({ workspaceHostScope: 'ssh:host-1' }))).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetAlwaysShowDefaultBranchWorkspace: false,
      resetVisibleWorkspaceHostIds: true
    })
  })

  it('flags only the default-branch exemption for reset when it is the sole filter', () => {
    expect(
      computeClearFilterActions(filterState({ alwaysShowDefaultBranchWorkspace: false }))
    ).toEqual({
      resetShowSleepingWorkspaces: false,
      resetFilterRepoIds: false,
      resetHideDefaultBranchWorkspace: false,
      resetHideAutomationGeneratedWorkspaces: false,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetAlwaysShowDefaultBranchWorkspace: true,
      resetVisibleWorkspaceHostIds: false
    })
  })

  it('flags every active filter simultaneously', () => {
    expect(
      computeClearFilterActions(
        filterState({
          showSleepingWorkspaces: false,
          filterRepoIds: ['repo1', 'repo2'],
          hideDefaultBranchWorkspace: true,
          hideAutomationGeneratedWorkspaces: true,
          visibleWorkspaceHostIds: ['local']
        })
      )
    ).toEqual({
      resetShowSleepingWorkspaces: true,
      resetFilterRepoIds: true,
      resetHideDefaultBranchWorkspace: true,
      resetHideAutomationGeneratedWorkspaces: true,
      resetHideCliCreatedWorkspaces: false,
      resetHideDetachedHeadWorkspaces: false,
      resetAlwaysShowDefaultBranchWorkspace: false,
      resetVisibleWorkspaceHostIds: true
    })
  })
})
