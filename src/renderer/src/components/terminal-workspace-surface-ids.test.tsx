// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'
import { useTerminalWorkspaceFoundation } from './use-terminal-workspace-foundation'
import { applyTerminalColdActivation } from './terminal-cold-activation'
import { collectTerminalParkingPassCandidates } from './terminal-parking-pass-candidates'
import type { WorkspaceSurface } from './workspace-surface-projection'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

const initialState = useAppStore.getInitialState()

/** An id-only surface array that reports how often a caller re-derived its ids. */
function countingSurfaces(ids: string[]): { surfaces: WorkspaceSurface[]; mapCalls: () => number } {
  let mapCalls = 0
  const surfaces = ids.map((id) => ({ id, path: `/tmp/${id}` }))
  Object.defineProperty(surfaces, 'map', {
    configurable: true,
    value(this: WorkspaceSurface[], ...args: Parameters<WorkspaceSurface[]['map']>) {
      mapCalls += 1
      return Array.prototype.map.apply(this, args)
    }
  })
  return { surfaces, mapCalls: () => mapCalls }
}

describe('workspace surface ids', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.restoreAllMocks()
  })

  it('keeps the id array and id set stable when a worktree write re-identifies the surfaces', () => {
    const repo = makeRepo()
    const first = makeWorktree('alpha', 'Alpha')
    const second = makeWorktree('beta', 'Beta')
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [first, second] } })

    const { result, rerender } = renderHook(() => useTerminalWorkspaceFoundation())
    const initialSurfaces = result.current.workspaceSurfaces
    const initialIds = result.current.workspaceSurfaceIds
    const initialIdSet = result.current.workspaceSurfaceIdSet
    expect(initialIds).toEqual([first.id, second.id])

    // A worktree write that changes no id: fresh row objects, fresh array.
    useAppStore.setState({
      worktreesByRepo: {
        [repo.id]: [
          { ...first, lastActivityAt: Date.now() },
          { ...second, lastActivityAt: Date.now() }
        ]
      }
    })
    rerender()

    expect(result.current.workspaceSurfaces).not.toBe(initialSurfaces)
    expect(result.current.workspaceSurfaceIds).toBe(initialIds)
    expect(result.current.workspaceSurfaceIdSet).toBe(initialIdSet)

    // A real membership change still re-identifies both.
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [first] } })
    rerender()
    expect(result.current.workspaceSurfaceIds).not.toBe(initialIds)
    expect(result.current.workspaceSurfaceIdSet).not.toBe(initialIdSet)
    expect(result.current.workspaceSurfaceIds).toEqual([first.id])
  })

  it('does not rebuild a surface-id array or set on a cold-activation render', () => {
    const ids = Array.from({ length: 423 }, (_, index) => `repo::/worktree-${index}`)
    const { surfaces, mapCalls } = countingSurfaces(ids)
    const controller = {
      activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
      activeGroupIdByWorktree: {},
      activeTabId: null,
      activeTabIdByWorktree: {},
      activeWorktreeDeferralHostId: null,
      activityTerminalPortals: [],
      backgroundMountTabIdsByWorktreeRef: { current: new Map() },
      backgroundMountColdRestorePaneKeysRef: { current: new Map() },
      groupsByWorktree: {},
      hydrationSucceeded: false,
      lastActivationWorktreeIdRef: { current: null },
      layoutByWorktree: {},
      mountedWorktreeIdsRef: { current: new Set(['repo::/worktree-0', 'repo::/gone']) },
      pairedRuntimeParkingEnvironmentIds: new Set(),
      pendingStartupByTabId: {},
      renderedActiveWorktreeId: null,
      startupWorktreeRefreshCompleted: false,
      tabsByWorktree: {},
      terminalParkingEnabled: true,
      terminalTitleSnapshotAuthorityEnabled: true,
      workspaceSessionReady: false,
      workspaceSurfaces: surfaces,
      workspaceSurfaceIds: ids,
      workspaceSurfaceIdSet: new Set(ids)
    } as unknown as TerminalParkingFoundation

    applyTerminalColdActivation(controller)
    applyTerminalColdActivation(controller)

    // Pre-fix this was two 423-element id arrays (plus a 423-entry Set) per render.
    expect(mapCalls()).toBe(0)
    expect(controller.mountedWorktreeIdsRef.current.has('repo::/gone')).toBe(false)
    expect(controller.mountedWorktreeIdsRef.current.has('repo::/worktree-0')).toBe(true)
  })

  it('does not rebuild a surface-id array or set on a parking pass', () => {
    const ids = Array.from({ length: 423 }, (_, index) => `repo::/worktree-${index}`)
    const { surfaces, mapCalls } = countingSurfaces(ids)
    const hiddenSince = new Map<string, number>([
      ['repo::/worktree-0', 1],
      ['repo::/stale', 2]
    ])
    const controller = {
      activeView: 'terminal',
      activityTerminalPortals: [],
      measurableBackgroundWorktreeIdsRef: { current: new Set() },
      measuringTerminalWorktreeIdsRef: { current: new Set() },
      mountedWorktreeIdsRef: { current: new Set(['repo::/worktree-0']) },
      pairedRuntimeParkingEnvironmentIds: new Set(),
      pendingStartupByTabId: {},
      renderedActiveWorktreeId: 'repo::/worktree-0',
      tabsByWorktree: {},
      terminalParkingEnabled: true,
      terminalSshParkingEnabled: true,
      terminalWorktreeHiddenSinceRef: { current: hiddenSince },
      terminalWorktreeParkCooldownUntilRef: { current: new Map() },
      terminalWorktreeParkingTimersRef: { current: new Map() },
      workspaceSurfaces: surfaces,
      workspaceSurfaceIds: ids,
      workspaceSurfaceIdSet: new Set(ids)
    } as unknown as TerminalParkingFoundation

    const pass = collectTerminalParkingPassCandidates(controller)

    // Pre-fix this allocated a 423-element id array and a 423-entry Set per fire.
    expect(mapCalls()).toBe(0)
    expect(pass.retentionCandidates.map((candidate) => candidate.worktreeId)).toEqual([
      'repo::/worktree-0'
    ])
    expect(hiddenSince.has('repo::/stale')).toBe(false)
  })
  it('stops idle worktree writes from re-firing surface-keyed terminal effects', () => {
    const repo = makeRepo()
    const worktrees = Array.from({ length: 20 }, (_, index) =>
      makeWorktree(`wt-${index}`, `Workspace ${index}`)
    )
    useAppStore.setState({ worktreesByRepo: { [repo.id]: worktrees } })

    const fires = { surfaceKeyed: 0, idKeyed: 0 }
    renderHook(() => {
      const foundation = useTerminalWorkspaceFoundation()
      useEffect(() => {
        fires.surfaceKeyed += 1
      }, [foundation.workspaceSurfaces])
      useEffect(() => {
        fires.idKeyed += 1
      }, [foundation.workspaceSurfaceIds])
    })
    expect(fires).toEqual({ surfaceKeyed: 1, idKeyed: 1 })

    // 100 worktree writes that touch no workspace id — the idle shape (activity
    // timestamps, status refreshes) that dominates a large profile.
    for (let write = 0; write < 100; write += 1) {
      act(() => {
        useAppStore.setState({
          worktreesByRepo: {
            [repo.id]: worktrees.map((worktree) => ({ ...worktree, lastActivityAt: write }))
          }
        })
      })
    }

    expect(fires.surfaceKeyed).toBe(101)
    expect(fires.idKeyed).toBe(1)
  })
})
