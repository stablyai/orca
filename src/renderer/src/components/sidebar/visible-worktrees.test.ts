/* eslint-disable max-lines */
import { describe, expect, it } from 'vitest'
import {
  computeClearFilterActions,
  computeVisibleWorktreeIds,
  isDefaultBranchWorkspace,
  sidebarHasActiveFilters
} from './visible-worktrees'
import type { Repo, TerminalTab, Worktree, WorktreeLineage } from '../../../../shared/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

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

function makeWorktree(id: string, repoId = 'repo1'): Worktree & { instanceId: string } {
  return {
    id,
    instanceId: `${id}-instance`,
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

function makeWorktreeLineage(
  child: Worktree & { instanceId: string },
  parent: Worktree & { instanceId: string },
  overrides: Partial<WorktreeLineage> = {}
): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId,
    origin: 'cli',
    capture: { source: 'terminal-context', confidence: 'inferred' },
    createdAt: 1,
    ...overrides
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
    showSleepingWorkspaces: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    hideDefaultBranchWorkspace: false,
    repoMap,
    workspaceHostScope: 'all',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    worktreeLineageById: {},
    ...overrides
  }
}

type FilterState = Parameters<typeof sidebarHasActiveFilters>[0]

function filterState(overrides: Partial<FilterState> = {}): FilterState {
  return {
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    hideDefaultBranchWorkspace: false,
    ...overrides
  }
}

describe('computeVisibleWorktreeIds', () => {
  it('keeps browser-tab worktrees visible when sleeping workspaces are hidden', () => {
    const wt = makeWorktree('wt-browser')

    const result = computeVisibleWorktreeIds(
      { repo1: [wt] },
      [wt.id],
      visibleOptions({
        showSleepingWorkspaces: false,
        browserTabsByWorktree: { [wt.id]: [{ id: 'browser-1' }] }
      })
    )

    expect(result).toEqual([wt.id])
  })

  it('hides sleeping worktrees when show sleeping is off', () => {
    const wt = makeWorktree('wt-sleeping')

    const result = computeVisibleWorktreeIds(
      { repo1: [wt] },
      [wt.id],
      visibleOptions({
        showSleepingWorkspaces: false
      })
    )

    expect(result).toEqual([])
  })

  it('does not treat slept wake-hint tabs as live surfaces', () => {
    const wt = makeWorktree('wt-slept')

    const result = computeVisibleWorktreeIds(
      { repo1: [wt] },
      [wt.id],
      visibleOptions({
        showSleepingWorkspaces: false,
        tabsByWorktree: { [wt.id]: [makeTab('tab-slept', wt.id, 'wake-hint-session')] },
        // Sleep preserves tab.ptyId as the wake hint but clears live PTY ids.
        ptyIdsByTabId: { 'tab-slept': [] }
      })
    )

    expect(result).toEqual([])
  })

  it('hides paired web host terminal mirrors while their stream handle is pending', () => {
    const wt = makeWorktree('wt-web-pending')

    const result = computeVisibleWorktreeIds(
      { repo1: [wt] },
      [wt.id],
      visibleOptions({
        showSleepingWorkspaces: false,
        tabsByWorktree: { [wt.id]: [makeTab('web-terminal-host-tab-1', wt.id, null)] },
        ptyIdsByTabId: {}
      })
    )

    expect(result).toEqual([])
  })

  it('keeps paired web host terminal mirrors visible after their stream handle is ready', () => {
    const wt = makeWorktree('wt-web-ready')

    const result = computeVisibleWorktreeIds(
      { repo1: [wt] },
      [wt.id],
      visibleOptions({
        showSleepingWorkspaces: false,
        tabsByWorktree: { [wt.id]: [makeTab('web-terminal-host-tab-1', wt.id, null)] },
        ptyIdsByTabId: { 'web-terminal-host-tab-1': ['pty-web-ready'] }
      })
    )

    expect(result).toEqual([wt.id])
  })

  it('hides branch-backed main worktrees when default branch workspaces are hidden', () => {
    const main = makeWorktree('main')
    const feature = makeWorktree('feature')
    main.isMainWorktree = true

    const result = computeVisibleWorktreeIds(
      { repo1: [main, feature] },
      [main.id, feature.id],
      visibleOptions({
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

  it('filters worktrees to a selected SSH host scope', () => {
    const local = makeWorktree('local', 'repo1')
    const remote = makeWorktree('remote', 'repo2')
    const scopedRepoMap = new Map(repoMap)
    scopedRepoMap.set('repo2', {
      ...makeRepo('repo2', 'Repo 2', '#111'),
      connectionId: 'win vm'
    })

    const result = computeVisibleWorktreeIds(
      { repo1: [local], repo2: [remote] },
      [local.id, remote.id],
      visibleOptions({
        repoMap: scopedRepoMap,
        workspaceHostScope: 'ssh:win%20vm'
      })
    )

    expect(result).toEqual([remote.id])
  })

  it('filters non-SSH worktrees to the focused runtime host compatibility scope', () => {
    const runtime = makeWorktree('runtime', 'repo1')
    const ssh = makeWorktree('ssh', 'repo2')
    const scopedRepoMap = new Map(repoMap)
    scopedRepoMap.set('repo2', {
      ...makeRepo('repo2', 'Repo 2', '#111'),
      connectionId: 'ssh-1'
    })

    const result = computeVisibleWorktreeIds(
      { repo1: [runtime], repo2: [ssh] },
      [runtime.id, ssh.id],
      visibleOptions({
        repoMap: scopedRepoMap,
        defaultHostId: 'runtime:env-1',
        workspaceHostScope: 'runtime:env-1'
      })
    )

    expect(result).toEqual([runtime.id])
  })

  it('filters explicit runtime-owned repos independently of the focused default host', () => {
    const local = makeWorktree('local', 'repo1')
    const runtime = makeWorktree('runtime', 'repo2')
    const scopedRepoMap = new Map(repoMap)
    scopedRepoMap.set('repo1', {
      ...makeRepo('repo1', 'Repo 1', '#000'),
      executionHostId: 'local'
    })
    scopedRepoMap.set('repo2', {
      ...makeRepo('repo2', 'Repo 2', '#111'),
      executionHostId: 'runtime:env-1'
    })

    const result = computeVisibleWorktreeIds(
      { repo1: [local], repo2: [runtime] },
      [local.id, runtime.id],
      visibleOptions({
        repoMap: scopedRepoMap,
        defaultHostId: 'runtime:env-1',
        workspaceHostScope: 'local'
      })
    )

    expect(result).toEqual([local.id])
  })

  it('keeps every host visible when workspace host scope is all', () => {
    const local = makeWorktree('local', 'repo1')
    const remote = makeWorktree('remote', 'repo2')
    const scopedRepoMap = new Map(repoMap)
    scopedRepoMap.set('repo2', {
      ...makeRepo('repo2', 'Repo 2', '#111'),
      connectionId: 'ssh-1'
    })

    const result = computeVisibleWorktreeIds(
      { repo1: [local], repo2: [remote] },
      [local.id, remote.id],
      visibleOptions({
        repoMap: scopedRepoMap,
        workspaceHostScope: 'all'
      })
    )

    expect(result).toEqual([local.id, remote.id])
  })

  it('filters worktrees to a selected set of visible hosts', () => {
    const local = makeWorktree('local', 'repo1')
    const ssh = makeWorktree('ssh', 'repo2')
    const runtime = makeWorktree('runtime', 'repo3')
    const scopedRepoMap = new Map(repoMap)
    scopedRepoMap.set('repo2', {
      ...makeRepo('repo2', 'Repo 2', '#111'),
      connectionId: 'ssh-1'
    })
    scopedRepoMap.set('repo3', {
      ...makeRepo('repo3', 'Repo 3', '#222'),
      executionHostId: 'runtime:env-1'
    })

    const result = computeVisibleWorktreeIds(
      { repo1: [local], repo2: [ssh], repo3: [runtime] },
      [local.id, ssh.id, runtime.id],
      visibleOptions({
        repoMap: scopedRepoMap,
        visibleWorkspaceHostIds: ['local', 'ssh:ssh-1']
      })
    )

    expect(result).toEqual([local.id, ssh.id])
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

  it('composes with sleeping visibility: hidden mains stay hidden while live features remain', () => {
    const main = makeWorktree('main')
    main.isMainWorktree = true
    const feature = makeWorktree('feature')

    // Why: verifies filter ordering — the default-branch hide runs before
    // sleeping visibility, so the hidden main does not slip back in while the
    // feature survives because it has a live PTY.
    const result = computeVisibleWorktreeIds(
      { repo1: [main, feature] },
      [main.id, feature.id],
      visibleOptions({
        showSleepingWorkspaces: false,
        tabsByWorktree: { [feature.id]: [makeTab('t1', feature.id, 'p1')] },
        ptyIdsByTabId: { t1: ['p1'] },
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

  it('includes valid lineage parents even when another filter would hide the parent', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const lineage = makeWorktreeLineage(child, parent)

    const result = computeVisibleWorktreeIds(
      { repo1: [parent, child] },
      [child.id, parent.id],
      visibleOptions({
        showSleepingWorkspaces: false,
        tabsByWorktree: { [child.id]: [makeTab('t-child', child.id, 'p-child')] },
        ptyIdsByTabId: { 't-child': ['p-child'] },
        worktreeLineageById: { [child.id]: lineage }
      })
    )

    expect(result).toEqual([parent.id, child.id])
  })

  it('does not resurrect stale lineage parents', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const lineage = makeWorktreeLineage(child, parent, {
      parentWorktreeInstanceId: 'old-parent-instance'
    })

    const result = computeVisibleWorktreeIds(
      { repo1: [parent, child] },
      [child.id, parent.id],
      visibleOptions({
        showSleepingWorkspaces: false,
        tabsByWorktree: { [child.id]: [makeTab('t-child', child.id, 'p-child')] },
        ptyIdsByTabId: { 't-child': ['p-child'] },
        worktreeLineageById: { [child.id]: lineage }
      })
    )

    expect(result).toEqual([child.id])
  })

  it('does not resurrect archived lineage parents', () => {
    const parent = makeWorktree('parent')
    parent.isArchived = true
    const child = makeWorktree('child')
    const lineage = makeWorktreeLineage(child, parent)

    const result = computeVisibleWorktreeIds(
      { repo1: [parent, child] },
      [child.id, parent.id],
      visibleOptions({
        showSleepingWorkspaces: false,
        tabsByWorktree: { [child.id]: [makeTab('t-child', child.id, 'p-child')] },
        ptyIdsByTabId: { 't-child': ['p-child'] },
        worktreeLineageById: { [child.id]: lineage }
      })
    )

    expect(result).toEqual([child.id])
  })

  it('includes default-branch parents hidden by the explicit setting when a visible child needs them', () => {
    const parent = makeWorktree('parent')
    parent.isMainWorktree = true
    const child = makeWorktree('child')
    const lineage = makeWorktreeLineage(child, parent)

    const result = computeVisibleWorktreeIds(
      { repo1: [parent, child] },
      [child.id, parent.id],
      visibleOptions({
        hideDefaultBranchWorkspace: true,
        worktreeLineageById: { [child.id]: lineage }
      })
    )

    expect(result).toEqual([parent.id, child.id])
  })

  it('includes cross-repo parents when repo filtering leaves their valid child visible', () => {
    const parent = makeWorktree('parent', 'repo1')
    const child = makeWorktree('child', 'repo2')
    const lineage = makeWorktreeLineage(child, parent)

    const result = computeVisibleWorktreeIds(
      { repo1: [parent], repo2: [child] },
      [child.id, parent.id],
      visibleOptions({
        filterRepoIds: ['repo2'],
        worktreeLineageById: { [child.id]: lineage }
      })
    )

    expect(result).toEqual([parent.id, child.id])
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
    // default-branch row sees "No workspaces found" with no way back.
    expect(sidebarHasActiveFilters(filterState({ hideDefaultBranchWorkspace: true }))).toBe(true)
  })

  it('returns true when sleeping workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ showSleepingWorkspaces: false }))).toBe(true)
  })

  it('returns true when only filterRepoIds is non-empty', () => {
    expect(sidebarHasActiveFilters(filterState({ filterRepoIds: ['repo1'] }))).toBe(true)
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

  it('flags every active filter simultaneously', () => {
    expect(
      computeClearFilterActions(
        filterState({
          showSleepingWorkspaces: false,
          filterRepoIds: ['repo1', 'repo2'],
          hideDefaultBranchWorkspace: true,
          visibleWorkspaceHostIds: ['local']
        })
      )
    ).toEqual({
      resetShowSleepingWorkspaces: true,
      resetFilterRepoIds: true,
      resetHideDefaultBranchWorkspace: true,
      resetVisibleWorkspaceHostIds: true
    })
  })
})
