import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getVisibleWorktreeIds, setVisibleWorktreeIds } from './visible-worktrees'
import type { AppState } from '@/store/types'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const initialState = useAppStore.getInitialState()

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

function makeMainWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree(id, { isMainWorktree: true, branch: 'refs/heads/main', ...overrides })
}

function makeRepo(id = 'repo1', overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    defaultBranch: 'main',
    connectionId: null,
    ...overrides
  } as unknown as Repo
}

function makeProjectGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: `/tmp/${id}`,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ProjectGroup
}

function makeFolderWorkspace(id: string, projectGroupId: string): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/tmp/${id}`,
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

/**
 * Seeds the store with the fields the closed-sidebar order reads, then drops the
 * published order so getVisibleWorktreeIds() must recompute it.
 */
function seedStore(worktrees: Worktree[], overrides: Partial<AppState> = {}): void {
  useAppStore.setState(
    {
      ...initialState,
      repos: [makeRepo()],
      worktreesByRepo: { repo1: worktrees },
      // Why showSleepingWorkspaces: fixtures have no PTYs, so the activity filter
      // would otherwise drop every workspace before ordering runs.
      showSleepingWorkspaces: true,
      groupBy: 'repo',
      sortBy: 'manual',
      ...overrides
    } as AppState,
    true
  )
  setVisibleWorktreeIds(null)
}

describe('closed-sidebar Cmd+1-9 ordering (#9497)', () => {
  afterEach(() => {
    setVisibleWorktreeIds(null)
    useAppStore.setState(initialState, true)
  })

  it('hoists the repo main worktree first, matching the rendered sidebar', () => {
    // Manual sort ranks by sortOrder descending, so the base sort puts the feature
    // workspace first; only the repo grouping layer hoists main ahead of it.
    const feature = makeWorktree('wt-feature', { sortOrder: 1 })
    const main = makeMainWorktree('wt-main', { sortOrder: 0 })
    seedStore([feature, main])

    const order = getVisibleWorktreeIds()

    expect(order).toEqual(['wt-main', 'wt-feature'])
    // The pre-fix flat fallback returned membership order and numbered the wrong card.
    expect(order).not.toEqual(['wt-feature', 'wt-main'])
  })

  it('ignores the agent-send collapse override, which only applies to a mounted list', () => {
    // Safe to ignore WorktreeList's effectiveCollapsedGroups override only because
    // it needs a mounted list, which publishes its order and skips this path.
    const main = makeMainWorktree('wt-main')
    const feature = makeWorktree('wt-feature')
    seedStore([main, feature], {
      collapsedGroups: new Set(['project:repo:repo1']),
      agentSendPopoverTargetMode: {
        worktreeId: 'wt-feature',
        id: 'send-1',
        instanceId: 'inst-1'
      } as AppState['agentSendPopoverTargetMode']
    })

    expect(getVisibleWorktreeIds()).toEqual([])

    setVisibleWorktreeIds(['wt-feature', 'wt-main'])
    expect(getVisibleWorktreeIds()).toEqual(['wt-feature', 'wt-main'])
  })

  it('places a pinned workspace per the pinned section under both display policies', () => {
    const main = makeMainWorktree('wt-main')
    const plain = makeWorktree('wt-plain')
    const pinned = makeWorktree('wt-pinned', { isPinned: true })

    for (const showPinnedWorktreesInGroups of [false, true]) {
      seedStore([main, plain, pinned], {
        settings: { showPinnedWorktreesInGroups } as AppState['settings']
      })

      const order = getVisibleWorktreeIds()

      // Each workspace owns exactly one ordinal even when pinning duplicates its row.
      expect(order).toEqual([...new Set(order)])
      expect([...order].sort()).toEqual(['wt-main', 'wt-pinned', 'wt-plain'])
      expect(order[0]).toBe(showPinnedWorktreesInGroups ? 'wt-main' : 'wt-pinned')
    }
  })

  it('elides members of a collapsed group, which render no card to number', () => {
    const main = makeMainWorktree('wt-main')
    const feature = makeWorktree('wt-feature')
    seedStore([main, feature], { collapsedGroups: new Set(['project:repo:repo1']) })

    expect(getVisibleWorktreeIds()).toEqual([])
  })

  it('numbers folder workspaces, which the flat fallback omitted entirely', () => {
    const group = makeProjectGroup('group-1')
    const folderWorkspace = makeFolderWorkspace('fw-1', group.id)
    seedStore([makeMainWorktree('wt-main')], {
      projectGroups: [group],
      folderWorkspaces: [folderWorkspace]
    })

    expect(getVisibleWorktreeIds()).toContain(folderWorkspaceKey(folderWorkspace.id))
  })

  it('numbers a workspace created while nothing was published', () => {
    // A retained-cache fix cannot surface this: it can only prune ids it already had.
    seedStore([makeMainWorktree('wt-main')])
    expect(getVisibleWorktreeIds()).toEqual(['wt-main'])

    seedStore([makeMainWorktree('wt-main'), makeWorktree('wt-created-while-closed')])

    expect(getVisibleWorktreeIds()).toEqual(['wt-main', 'wt-created-while-closed'])
  })

  it('treats a published order as authoritative, including an explicitly empty one', () => {
    seedStore([makeMainWorktree('wt-main'), makeWorktree('wt-feature')])

    setVisibleWorktreeIds(['x'])
    expect(getVisibleWorktreeIds()).toEqual(['x'])

    // An empty rendered sidebar is a real order; the old length check fell through here.
    setVisibleWorktreeIds([])
    expect(getVisibleWorktreeIds()).toEqual([])

    setVisibleWorktreeIds(null)
    expect(getVisibleWorktreeIds()).toEqual(['wt-main', 'wt-feature'])
  })

  it('honors an explicit host filter and keeps the all-hosts default unfiltered', () => {
    const localRepo = makeRepo('repo1')
    const sshRepo = makeRepo('repo-ssh', { connectionId: 'my-target' })
    // Base sort interleaves the hosts, so any host grouping has to reorder them.
    const localMain = makeMainWorktree('wt-local-main', { sortOrder: 3 })
    const remoteMain = makeMainWorktree('wt-remote-main', { repoId: 'repo-ssh', sortOrder: 2 })
    const localFeature = makeWorktree('wt-local-feature', { sortOrder: 1 })
    const remoteFeature = makeWorktree('wt-remote-feature', { repoId: 'repo-ssh', sortOrder: 0 })
    const storeOverrides = {
      repos: [localRepo, sshRepo],
      worktreesByRepo: {
        repo1: [localMain, localFeature],
        'repo-ssh': [remoteMain, remoteFeature]
      },
      sshTargetLabels: new Map([['my-target', 'My Target']])
    } as Partial<AppState>

    seedStore([], storeOverrides)
    // Default all-hosts scope adds no host sections, so repo grouping alone orders it.
    expect(getVisibleWorktreeIds()).toEqual([
      'wt-local-main',
      'wt-local-feature',
      'wt-remote-main',
      'wt-remote-feature'
    ])

    seedStore([], { ...storeOverrides, visibleWorkspaceHostIds: ['local'] })
    expect(getVisibleWorktreeIds()).toEqual(['wt-local-main', 'wt-local-feature'])

    seedStore([], {
      ...storeOverrides,
      visibleWorkspaceHostIds: ['ssh:my-target', 'local']
    })
    // Host sections keep each host's workspaces contiguous, ordered by the host
    // registry (local first) rather than by the filter argument's order.
    expect(getVisibleWorktreeIds()).toEqual([
      'wt-local-main',
      'wt-local-feature',
      'wt-remote-main',
      'wt-remote-feature'
    ])
  })

  it('keeps the sort layer intact for smart and comparator sort modes', () => {
    const main = makeMainWorktree('wt-main')
    const older = makeWorktree('wt-older', { displayName: 'b-older', lastActivityAt: 1 })
    const newer = makeWorktree('wt-newer', { displayName: 'a-newer', lastActivityAt: 999 })

    seedStore([older, newer, main], { sortBy: 'smart' })
    expect(getVisibleWorktreeIds()).toEqual(['wt-main', 'wt-newer', 'wt-older'])

    seedStore([older, newer, main], { sortBy: 'name' })
    expect(getVisibleWorktreeIds()).toEqual(['wt-main', 'wt-newer', 'wt-older'])
  })
})
