// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ResourceManagerWorktreeTarget } from './resource-manager-worktree-target'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  getKnownWorktreeById: vi.fn(),
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
      runtimeEnvironmentCatalogHydrated: true
    })
  }
}))
vi.mock('../../store/selectors', () => ({ getAllWorktreesFromState: () => mocks.worktrees }))
vi.mock('../sidebar/delete-worktree-flow', () => ({ runWorktreeDelete: vi.fn() }))

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
