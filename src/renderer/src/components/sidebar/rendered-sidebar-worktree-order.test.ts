import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  getVisibleWorktreeIds,
  getVisibleWorktreeShortcutTargets,
  setVisibleWorktreeIds,
  setVisibleWorktreeShortcutTargets
} from './visible-worktrees'
import type { AppState } from '@/store/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
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

/** Clear the published order so the closed-sidebar fallback must recompute it from store fields. */
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
  setVisibleWorktreeShortcutTargets(null)
}

describe('closed-sidebar Cmd+1-9 ordering (#9497)', () => {
  afterEach(() => {
    setVisibleWorktreeIds(null)
    setVisibleWorktreeShortcutTargets(null)
    useAppStore.setState(initialState, true)
  })

  it('hoists the repo main worktree first, matching the rendered sidebar', () => {
    // Arrange flat sort to disagree with grouping so the main-worktree hoist is observable.
    const feature = makeWorktree('wt-feature', { sortOrder: 1 })
    const main = makeMainWorktree('wt-main', { sortOrder: 0 })
    seedStore([feature, main])

    const order = getVisibleWorktreeIds()

    expect(order).toEqual(['wt-main', 'wt-feature'])
    expect(order).not.toEqual(['wt-feature', 'wt-main'])
  })

  it('ignores the agent-send collapse override, which only applies to a mounted list', () => {
    // The send-collapse override requires a mounted list, which publishes its own order and bypasses this fallback.
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
    // A retained cache cannot discover newly created IDs; this path must recompute membership.
    seedStore([makeMainWorktree('wt-main')])
    expect(getVisibleWorktreeIds()).toEqual(['wt-main'])

    seedStore([makeMainWorktree('wt-main'), makeWorktree('wt-created-while-closed')])

    expect(getVisibleWorktreeIds()).toEqual(['wt-main', 'wt-created-while-closed'])
  })

  it('treats a published order as authoritative, including an explicitly empty one', () => {
    seedStore([makeMainWorktree('wt-main'), makeWorktree('wt-feature')])

    setVisibleWorktreeIds(['x'])
    expect(getVisibleWorktreeIds()).toEqual(['x'])

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
    // Host registry order, rather than filter argument order, keeps each host’s workspaces contiguous.
    expect(getVisibleWorktreeIds()).toEqual([
      'wt-local-main',
      'wt-local-feature',
      'wt-remote-main',
      'wt-remote-feature'
    ])
  })

  it("orders a card in a paired host's own column by that column, not the default", () => {
    const today = makeWorktree('wt-today', { workspaceStatus: 'status-6', sortOrder: 0 })
    const todo = makeWorktree('wt-todo', { workspaceStatus: 'todo', sortOrder: 1 })
    const doing = makeWorktree('wt-doing', { workspaceStatus: 'in-progress', sortOrder: 2 })
    seedStore([today, todo, doing], {
      groupBy: 'workspace-status',
      workspaceStatuses: [
        { id: 'in-progress', label: 'In progress' },
        { id: 'todo', label: 'Todo' }
      ],
      hostWorkspaceStatuses: { 'env-1': [{ id: 'status-6', label: '🔥 今天收尾' }] }
    })

    expect(getVisibleWorktreeIds()).toEqual(['wt-doing', 'wt-todo', 'wt-today'])
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

  it('keeps same-id hosts as separate closed-sidebar shortcut positions', () => {
    seedStore([
      makeWorktree('repo1::/same', { hostId: 'local' }),
      makeWorktree('repo1::/same', { hostId: 'ssh:box' })
    ])

    expect(getVisibleWorktreeIds()).toEqual(['repo1::/same'])
    expect(getVisibleWorktreeShortcutTargets()).toEqual([
      { id: 'repo1::/same', executionHostId: 'local' },
      { id: 'repo1::/same', executionHostId: 'ssh:box' }
    ])
  })

  it('does not reconstruct a filtered same-id host in closed-sidebar shortcuts', () => {
    seedStore(
      [
        makeWorktree('repo1::/same', { hostId: 'local' }),
        makeWorktree('repo1::/same', { hostId: 'ssh:box' })
      ],
      { visibleWorkspaceHostIds: ['local'] }
    )

    expect(getVisibleWorktreeIds()).toEqual(['repo1::/same'])
    expect(getVisibleWorktreeShortcutTargets()).toEqual([
      { id: 'repo1::/same', executionHostId: 'local' }
    ])
  })
})
