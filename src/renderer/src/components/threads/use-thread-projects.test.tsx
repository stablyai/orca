// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { useThreadProjects } from './use-thread-projects'
import {
  refreshLocalRuntimeCapabilities,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import * as projects from './thread-projects'
const supports = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<object>()),
  structuredAgentSessionHostSupports: supports
}))
beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it.each([
  [20, 2],
  [200, 2],
  [20, 20],
  [20, 200]
])(
  'bounds catalog work for %i worktrees and %i projects; only candidate host changes reacquire capabilities',
  async (worktreeCount, projectCount) => {
    const repos = Array.from({ length: projectCount }, (_, i) => ({
      id: `r-${i}`,
      path: `/r-${i}`,
      displayName: `R ${i}`,
      addedAt: i,
      badgeColor: '',
      executionHostId: 'runtime:chosen' as const
    }))
    const worktrees = Array.from({ length: worktreeCount }, (_, i) =>
      makeWorktree({
        id: `w-${i}`,
        repoId: repos[i % projectCount].id,
        path: `/w-${i}`,
        hostId: 'runtime:chosen',
        isMainWorktree: i < projectCount
      })
    )
    useAppStore.setState({
      repos,
      worktreesByRepo: Object.fromEntries(
        repos.map((r) => [r.id, worktrees.filter((w) => w.repoId === r.id)])
      ),
      folderWorkspaces: [],
      projectGroups: [],
      activeWorktreeId: worktrees[0].id,
      activeWorkspaceExecutionHostId: 'runtime:chosen',
      lastVisitedAtByWorktreeId: {},
      runtimeStatusByEnvironmentId: new Map()
    })
    let visits = 0
    for (const worktree of worktrees) {
      const repoId = worktree.repoId
      Object.defineProperty(worktree, 'repoId', {
        get: () => {
          visits++
          return repoId
        }
      })
    }
    const derive = vi.spyOn(projects, 'threadProjectCandidates')
    let renders = 0
    const view = renderHook(() => {
      renders++
      return useThreadProjects()
    })
    await waitFor(() => expect(view.result.current.loading).toBe(false))
    expect(derive).toHaveBeenCalledOnce()
    const ready = view.result.current.projects
    expect(ready).toHaveLength(Math.min(worktreeCount, projectCount))
    expect(visits).toBeGreaterThanOrEqual(worktreeCount)
    expect(visits).toBeLessThanOrEqual(30 * (worktreeCount + projectCount))
    visits = 0
    const beforeRenders = renders
    const checks = supports.mock.calls.length
    expect(checks).toBe(ready.length)
    derive.mockClear()
    supports.mockClear()
    const settled = view.result.current
    for (let i = 0; i < 3; i++) {
      act(() =>
        useAppStore.setState({
          runtimeStatusByEnvironmentId: new Map([
            [`other-${i}`, { status: null, checkedAt: i, connectionGeneration: i }]
          ])
        })
      )
      expect(view.result.current).toBe(settled)
    }
    expect(visits).toBe(0)
    expect(renders).toBe(beforeRenders)
    expect(derive).not.toHaveBeenCalled()
    expect(supports).not.toHaveBeenCalled()
    const pending = Promise.withResolvers<boolean>()
    supports.mockReturnValue(pending.promise)
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ['chosen', { status: null, checkedAt: 1, connectionGeneration: 2 }]
        ])
      })
    )
    expect(view.result.current.loading).toBe(false)
    expect(view.result.current.projects).toBe(ready)
    expect(derive).not.toHaveBeenCalled()
    await act(async () => pending.resolve(false))
    await waitFor(() => expect(view.result.current.projects).toHaveLength(0))
    supports.mockResolvedValue(true)
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ['chosen', { status: null, checkedAt: 2, connectionGeneration: 3, hostContactEpoch: 1 }]
        ])
      })
    )
    await waitFor(() => expect(view.result.current.projects).toHaveLength(ready.length))
    act(() => useAppStore.setState({ repos: [] }))
    await waitFor(() => expect(view.result.current.projects).toHaveLength(0))
  }
)

it('does not reacquire on its own unavailable local probe; a later learned capability wakes the catalog', async () => {
  setLocalRuntimeCapabilitiesForTests(null)
  supports.mockResolvedValue(false)
  const repo = { id: 'r', path: '/r', displayName: 'R', addedAt: 1, badgeColor: '' }
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: {
      r: [
        makeWorktree({
          id: 'r::/r',
          repoId: 'r',
          path: '/r',
          hostId: 'local',
          isMainWorktree: true
        })
      ]
    },
    folderWorkspaces: [],
    projectGroups: [],
    activeWorktreeId: null,
    lastVisitedAtByWorktreeId: {}
  })
  const getStatus = vi.fn().mockRejectedValue(new Error('unavailable'))
  Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { getStatus } } })
  const view = renderHook(() => useThreadProjects())
  await waitFor(() => expect(view.result.current.loading).toBe(false))
  supports.mockClear()
  await act(async () => {
    await refreshLocalRuntimeCapabilities()
  })
  expect(supports).not.toHaveBeenCalled()
  expect(view.result.current.projects).toEqual([])
  supports.mockResolvedValue(true)
  getStatus.mockResolvedValue({ capabilities: ['agent-session-create-surface'] })
  await act(async () => {
    await refreshLocalRuntimeCapabilities()
  })
  await waitFor(() => expect(view.result.current.projects).toHaveLength(1))
  view.unmount()
  setLocalRuntimeCapabilitiesForTests(null)
})
