import { describe, expect, it } from 'vitest'
import { computeRenderedSidebarWorktreeOrder } from './rendered-sidebar-worktree-order'
import type { AppState } from '@/store/types'
import type { Repo, Worktree } from '../../../../shared/types'

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo1',
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
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
    lastActivityAt: 0,
    ...overrides
  } as Worktree
}

function makeRepo(id = 'repo1'): Repo {
  return { id, name: id, path: `/tmp/${id}`, defaultBranch: 'main' } as unknown as Repo
}

/** Minimal store snapshot: only the fields the rendered-order pipeline reads. */
function makeState(worktrees: Worktree[], overrides: Partial<AppState> = {}): AppState {
  return {
    repos: [makeRepo()],
    worktreesByRepo: { repo1: worktrees },
    groupBy: 'repo',
    sortBy: 'manual',
    projectOrderBy: 'manual',
    collapsedGroups: new Set<string>(),
    workspaceStatuses: [],
    worktreeLineageById: {},
    folderWorkspaces: [],
    projectGroups: [],
    settings: null,
    prCache: null,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: null,
    workspaceHostOrder: [],
    sshTargetLabels: new Map(),
    sshConnectionStates: new Map(),
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    projectHostSetups: [],
    ...overrides
  } as unknown as AppState
}

describe('computeRenderedSidebarWorktreeOrder', () => {
  it('hoists the main worktree ahead of a higher-ranked child, like the rendered sidebar (#9497)', () => {
    // The flat fallback preserved membership order; the sidebar anchors the repo's
    // main workspace first, so Cmd+1 used to land on the wrong card.
    const feature = makeWorktree('wt-feature')
    const main = makeWorktree('wt-main', { isMainWorktree: true, branch: 'refs/heads/main' })
    const state = makeState([feature, main])

    expect(computeRenderedSidebarWorktreeOrder(state, [feature, main])).toEqual([
      'wt-main',
      'wt-feature'
    ])
  })

  it('omits workspaces in a collapsed group, which render no card and so own no number', () => {
    const main = makeWorktree('wt-main', { isMainWorktree: true, branch: 'refs/heads/main' })
    const feature = makeWorktree('wt-feature')
    // Legacy repos project to a synthetic project group, so that is the collapse key.
    const state = makeState([main, feature], {
      collapsedGroups: new Set(['project:repo:repo1'])
    })

    expect(computeRenderedSidebarWorktreeOrder(state, [main, feature])).toEqual([])
  })

  it('numbers a workspace created while the sidebar was closed', () => {
    // A retained-cache fix cannot do this: it can only ever remove stale ids.
    const main = makeWorktree('wt-main', { isMainWorktree: true, branch: 'refs/heads/main' })
    const created = makeWorktree('wt-new')
    const state = makeState([main, created])

    expect(computeRenderedSidebarWorktreeOrder(state, [main, created])).toEqual([
      'wt-main',
      'wt-new'
    ])
  })

  it('emits each workspace once even when pinning would duplicate its row', () => {
    const main = makeWorktree('wt-main', { isMainWorktree: true, branch: 'refs/heads/main' })
    const pinned = makeWorktree('wt-pinned', { isPinned: true })
    const state = makeState([main, pinned])

    const order = computeRenderedSidebarWorktreeOrder(state, [main, pinned])

    expect(order).toEqual([...new Set(order)])
    expect(order).toContain('wt-pinned')
  })

  it('keeps grouping-free ordering intact when groupBy is none', () => {
    const feature = makeWorktree('wt-feature')
    const main = makeWorktree('wt-main', { isMainWorktree: true, branch: 'refs/heads/main' })
    const state = makeState([feature, main], { groupBy: 'none' })

    expect(computeRenderedSidebarWorktreeOrder(state, [feature, main])).toEqual([
      'wt-feature',
      'wt-main'
    ])
  })
})
