// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ResourceManagerWorktreeTarget } from './resource-manager-worktree-target'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  getKnownWorktreeById: vi.fn(),
  runWorktreeDelete: vi.fn(),
  activeWorktreeId: 'focused-remote',
  activeWorkspaceExecutionHostId: 'runtime:focused' as const,
  folderWorkspaces: Array<{
    id: string
    projectGroupId: string
    connectionId: string | null
    executionHostId: ExecutionHostId
    diffComments: []
  }>(),
  worktrees: Array<
    ResourceManagerWorktreeTarget & { repoId: string; runtimeOwnerEnvironmentId?: string }
  >()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      getKnownWorktreeById: mocks.getKnownWorktreeById,
      worktreesByRepo: { repo: mocks.worktrees },
      detectedWorktreesByRepo: {},
      folderWorkspaces: mocks.folderWorkspaces,
      projectGroups: [],
      repos: [],
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      activeWorktreeId: mocks.activeWorktreeId,
      activeWorkspaceExecutionHostId: mocks.activeWorkspaceExecutionHostId
    })
  }
}))
vi.mock('../../store/selectors', () => ({ getAllWorktreesFromState: () => mocks.worktrees }))
vi.mock('../sidebar/delete-worktree-flow', () => ({ runWorktreeDelete: mocks.runWorktreeDelete }))

import { useResourceUsageActions } from './use-resource-usage-actions'

function renderActions(activeHostId: ExecutionHostId = 'local') {
  return renderHook(() =>
    useResourceUsageActions({
      activeHostId,
      setCollapsedRepos: vi.fn(),
      setCollapsedWorktrees: vi.fn(),
      tabsByWorktree: {},
      setOpen: vi.fn(),
      setActiveView: vi.fn(),
      openModal: vi.fn(),
      openSpacePage: vi.fn(),
      refreshSessions: vi.fn(async () => {}),
      removeSession: vi.fn(),
      removeSessions: vi.fn(),
      sessions: [],
      resourceSessionBindings: {
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        workspaceSessionReady: true
      },
      workspaceSessionReady: true,
      killConfirm: null,
      setKillConfirm: vi.fn(),
      setKilling: vi.fn(),
      mountedRef: { current: true },
      cancelPopoverBodyFocusFrame: vi.fn(),
      popoverBodyRef: { current: null },
      popoverBodyFocusFrameRef: { current: null }
    })
  ).result.current
}

beforeEach(() => {
  mocks.activateAndRevealWorkspace.mockReset()
  mocks.activateAndRevealWorktree.mockReset()
  mocks.getKnownWorktreeById.mockReset()
  mocks.runWorktreeDelete.mockReset()
  mocks.activeWorktreeId = 'focused-remote'
  mocks.folderWorkspaces = [
    {
      id: 'notes',
      projectGroupId: 'folders',
      connectionId: null,
      executionHostId: 'local',
      diffComments: []
    }
  ]
  mocks.worktrees = [{ id: 'repo::/notes', repoId: 'repo', hostId: 'ssh:box' }]
  mocks.getKnownWorktreeById.mockImplementation(
    (worktreeId: string, executionHostId: ExecutionHostId) =>
      mocks.worktrees.find(
        (worktree) =>
          worktree.id === worktreeId &&
          (worktree.hostId === executionHostId ||
            (worktree.runtimeOwnerEnvironmentId &&
              executionHostId === `runtime:${worktree.runtimeOwnerEnvironmentId}`))
      )
  )
})
afterEach(cleanup)

describe('Resource Manager sampled workspace actions', () => {
  it.each(['ssh:box', 'runtime:paired'] as const)(
    'qualifies sampled local navigation and deletion despite a %s twin and remote focus',
    (hostId) => {
      mocks.worktrees = [
        { id: 'repo::/same', repoId: 'repo', hostId },
        { id: 'repo::/same', repoId: 'repo', hostId: 'local' }
      ]
      mocks.activeWorktreeId = 'repo::/same'
      const actions = renderActions('local')

      actions.navigateToWorktree('repo::/same', 'local')
      actions.deleteWorktree('repo::/same', 'local')

      expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::/same', {
        executionHostId: 'local'
      })
      expect(mocks.runWorktreeDelete).toHaveBeenCalledWith('repo::/same', {
        expectedHostId: 'local'
      })
    }
  )

  it('passes the sampled local host explicitly for an unstamped local target', () => {
    mocks.worktrees = [{ id: 'repo::/same', repoId: 'repo' }]
    renderActions().deleteWorktree('repo::/same', 'local')
    expect(mocks.runWorktreeDelete).toHaveBeenCalledWith('repo::/same', { expectedHostId: 'local' })
  })

  it('refuses sampled deletion when two targets exist on the sampled host', () => {
    mocks.worktrees = [
      { id: 'repo::/same', repoId: 'repo', hostId: 'local' },
      { id: 'repo::/same', repoId: 'repo', hostId: 'local' }
    ]
    renderActions().deleteWorktree('repo::/same', 'local')
    expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
  })

  it('refuses unqualified deletion of unsampled twins', () => {
    mocks.worktrees = [
      { id: 'repo::/same', repoId: 'repo', hostId: 'local' },
      { id: 'repo::/same', repoId: 'repo', hostId: 'ssh:box' }
    ]
    renderActions().deleteWorktree('repo::/same')
    expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
  })

  it('refuses deletion and local navigation fallback from a remote view', () => {
    mocks.worktrees = [{ id: 'repo::/same', repoId: 'repo', hostId: 'local' }]
    const actions = renderActions('runtime:paired')
    actions.navigateToWorktree('repo::/same')
    actions.deleteWorktree('repo::/same')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
  })

  it('refuses a sample qualifier that contradicts the selected collector', () => {
    renderActions('runtime:paired').navigateToWorktree('repo::/notes', 'local')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})

describe('Resource Manager row navigation', () => {
  it('activates a folder workspace row through the workspace dispatcher', () => {
    renderActions().navigateToWorktree('folder:notes')

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:notes', {
      executionHostId: 'local'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('routes an SSH worktree reported by the local collector through its execution owner', () => {
    renderActions('local').navigateToWorktree('repo::/notes')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::/notes', {
      executionHostId: 'ssh:box'
    })
  })

  it('routes an SSH folder reported by the local collector through its execution owner', () => {
    mocks.folderWorkspaces = [
      {
        id: 'notes',
        projectGroupId: 'folders',
        connectionId: 'box',
        executionHostId: 'ssh:box',
        diffComments: []
      }
    ]

    renderActions('local').navigateToWorktree('folder:notes')

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:notes', {
      executionHostId: 'ssh:box'
    })
  })

  it('fails closed when the local collector reports an id owned by several hosts', () => {
    mocks.worktrees = [
      { id: 'repo::/same', repoId: 'repo', hostId: 'local' },
      { id: 'repo::/same', repoId: 'repo', hostId: 'ssh:box' }
    ]

    renderActions('local').navigateToWorktree('repo::/same')

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('still routes worktree rows through the host-resolved activator', () => {
    renderActions('ssh:box').navigateToWorktree('repo::/notes')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::/notes', {
      executionHostId: 'ssh:box'
    })
    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
  })

  it('routes a runtime-owned SSH alias through its selected runtime host', () => {
    mocks.worktrees = [
      {
        id: 'runtime-alias',
        repoId: 'repo',
        hostId: 'ssh:runtime-owned',
        runtimeOwnerEnvironmentId: 'paired'
      }
    ]

    renderActions('runtime:paired').navigateToWorktree('runtime-alias')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('runtime-alias', {
      executionHostId: 'runtime:paired'
    })
  })

  it('routes a duplicate worktree id to the host selected in Resource Manager', () => {
    mocks.worktrees = [
      { id: 'same-id', repoId: 'repo', hostId: 'local' },
      { id: 'same-id', repoId: 'repo', hostId: 'runtime:env-1' }
    ]

    renderActions('runtime:env-1').navigateToWorktree('same-id')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('same-id', {
      executionHostId: 'runtime:env-1'
    })
  })
})
