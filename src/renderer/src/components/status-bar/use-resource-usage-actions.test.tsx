// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceManagerWorktreeTarget } from './resource-manager-worktree-target'
import { ResourceSessionInventoryCache } from './resource-session-inventory-cache'
import type { DaemonSession, UnifiedSessionRow } from './resource-usage-merge-types'

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

function renderActions(overrides: Partial<Parameters<typeof useResourceUsageActions>[0]> = {}) {
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
      popoverBodyFocusFrameRef: { current: null },
      ...overrides
    })
  ).result.current
}

beforeEach(() => {
  mocks.activateAndRevealWorkspace.mockReset()
  mocks.activateAndRevealWorktree.mockReset()
  mocks.worktrees = [{ id: 'repo::/notes', hostId: 'ssh:box' }]
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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

describe('Resource Manager completion identity', () => {
  const session = (id: string, incarnationId?: string): DaemonSession => ({
    id,
    incarnationId,
    cwd: '/workspace',
    title: id,
    agentOwnership: 'absent'
  })

  it('removes only captured bulk targets after a replacement is published', async () => {
    vi.useFakeTimers()
    const original = [session('one', 'A'), session('two', 'C')]
    const replacement = session('one', 'B')
    const list = vi.fn().mockResolvedValue(original)
    const cache = new ResourceSessionInventoryCache(list, false)
    cache.setActive(true)
    await cache.refresh()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const kill = vi.fn(() => pending)
    vi.stubGlobal('api', { pty: { kill } })
    const actions = renderActions({
      sessions: original,
      removeSession: (id, incarnationId) => cache.remove(id, incarnationId),
      removeSessions: (targets) => cache.removeMany(targets),
      refreshSessions: cache.refresh
    })
    let completion!: Promise<void>
    act(() => {
      completion = actions.handleKillOrphans()
    })
    list.mockResolvedValue([replacement, original[1]])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(cache.getSnapshot().sessionInventory.sessions).toEqual([replacement, original[1]])
    await act(async () => {
      finish()
      await completion
    })
    expect(cache.getSnapshot().sessionInventory.sessions).toEqual([replacement])
    list.mockResolvedValue([replacement])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(cache.getSnapshot().sessionInventory.sessions).toEqual([replacement])
    cache.setActive(false)
  })

  it.each([
    { confirmed: false, incarnationId: 'A' },
    { confirmed: true, incarnationId: 'A' },
    { confirmed: false, incarnationId: undefined }
  ])(
    'retains a replacement after individual completion: %j',
    async ({ confirmed, incarnationId }) => {
      vi.useFakeTimers()
      const original = session('one', incarnationId)
      const replacement = session('one', 'B')
      const list = vi.fn().mockResolvedValue([original])
      const cache = new ResourceSessionInventoryCache(list, false)
      cache.setActive(true)
      await cache.refresh()
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      vi.stubGlobal('api', { pty: { kill: () => pending } })
      const row: UnifiedSessionRow = {
        sessionId: original.id,
        incarnationId,
        paneKey: null,
        pid: 1,
        label: 'one',
        bound: confirmed,
        agentOwnership: 'absent',
        tabId: null,
        cpu: null,
        memory: null,
        hasLocalSamples: false
      }
      const actions = renderActions({
        sessions: [original],
        killConfirm: confirmed ? row : null,
        removeSession: (id, identity) => cache.remove(id, identity),
        removeSessions: (targets) => cache.removeMany(targets),
        refreshSessions: cache.refresh
      })
      let completion: Promise<void> | undefined
      act(() => {
        if (confirmed) {
          completion = actions.runKillConfirmed()
        } else {
          actions.handleKillSession(row)
        }
      })
      list.mockResolvedValue([replacement])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(cache.getSnapshot().sessionInventory.sessions).toEqual([replacement])
      await act(async () => {
        finish()
        await pending
        await completion
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(cache.getSnapshot().sessionInventory.sessions).toEqual([replacement])
      cache.setActive(false)
    }
  )
})
