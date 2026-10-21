// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceManagerWorktreeTarget } from './resource-manager-worktree-target'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  worktrees: [] as ResourceManagerWorktreeTarget[]
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../../store/selectors', () => ({ getAllWorktreesFromState: () => mocks.worktrees }))
vi.mock('../sidebar/delete-worktree-flow', () => ({ runWorktreeDelete: vi.fn() }))

import { useResourceUsageActions } from './use-resource-usage-actions'

function renderActions() {
  return renderHook(() =>
    useResourceUsageActions({
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
  mocks.worktrees = [{ id: 'repo::/notes', hostId: 'ssh:box' }]
})
afterEach(cleanup)

describe('Resource Manager row navigation', () => {
  it('activates a folder workspace row through the workspace dispatcher', () => {
    renderActions().navigateToWorktree('folder:notes')

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:notes')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('still routes worktree rows through the host-resolved activator', () => {
    renderActions().navigateToWorktree('repo::/notes')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::/notes', {
      executionHostId: 'ssh:box'
    })
    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
  })
})
