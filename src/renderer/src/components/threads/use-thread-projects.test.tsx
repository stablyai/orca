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
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { AGENT_SESSION_CREATE_SURFACE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
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
  [20, 2, 1, 20],
  [200, 2, 1, 200],
  [20, 20, 20, 20],
  [200, 200, 200, 200]
])(
  'bounds catalog work for %i worktrees and %i projects / %i hosts; only candidate host changes reacquire capabilities',
  async (worktreeCount, projectCount, hostCount, capabilityCount) => {
    const capabilities = Array.from(
      { length: capabilityCount },
      (_, i) => RUNTIME_CAPABILITIES[i % RUNTIME_CAPABILITIES.length]
    )
    const capabilityBytes = JSON.stringify(capabilities).length
    const repos = Array.from({ length: projectCount }, (_, i) => ({
      id: `r-${i}`,
      path: `/r-${i}`,
      displayName: `R ${i}`,
      addedAt: i,
      badgeColor: '',
      executionHostId: `runtime:chosen-${i % hostCount}` as const
    }))
    const worktrees = Array.from({ length: worktreeCount }, (_, i) =>
      makeWorktree({
        id: `w-${i}`,
        repoId: repos[i % projectCount].id,
        path: `/w-${i}`,
        hostId: repos[i % projectCount].executionHostId,
        isMainWorktree: i < projectCount
      })
    )
    const statuses = new Map<string, RuntimeEnvironmentStatus>(
      Array.from({ length: hostCount }, (_, i) => [
        `chosen-${i}`,
        {
          checkedAt: 1,
          status: {
            runtimeId: `perf-host-${i}`,
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: 1,
            liveTabCount: 0,
            liveLeafCount: 0,
            capabilities
          }
        }
      ])
    )
    replaceRuntimeEnvironmentRevisions(
      Array.from({ length: hostCount }, (_, i) => ({ id: `chosen-${i}`, createdAt: 1 }))
    )
    useAppStore.setState({
      repos,
      worktreesByRepo: Object.fromEntries(
        repos.map((r) => [r.id, worktrees.filter((w) => w.repoId === r.id)])
      ),
      folderWorkspaces: [],
      projectGroups: [],
      activeWorktreeId: worktrees[0].id,
      activeWorkspaceExecutionHostId: 'runtime:chosen-0',
      lastVisitedAtByWorktreeId: {},
      runtimeStatusByEnvironmentId: statuses
    })
    let generationVisits = 0
    let bytes = 0
    const statusMaps = new WeakSet<object>([statuses])
    const get = Map.prototype.get
    vi.spyOn(Map.prototype, 'get').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown
    ) {
      if (statusMaps.has(this)) {
        generationVisits++
      }
      return get.call(this, key)
    })
    const stringify = JSON.stringify
    vi.spyOn(JSON, 'stringify').mockImplementation((value, ...rest) => {
      const result = stringify(value, ...rest)
      if (result?.includes('perf-host-')) {
        bytes += result.length
      }
      return result
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
    expect(generationVisits).toBeLessThanOrEqual(3 * hostCount)
    expect(bytes).toBeLessThanOrEqual(3 * hostCount * (capabilityBytes + 200))
    expect(bytes).toBeGreaterThan(0)
    generationVisits = 0
    bytes = 0
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
      act(() => useAppStore.setState({ settingsSearchQuery: `unrelated-${i}` }))
    }
    expect(generationVisits).toBe(0)
    expect(bytes).toBe(0)
    const tracked = (map: typeof statuses) => {
      statusMaps.add(map)
      return map
    }
    for (let i = 0; i < 3; i++) {
      act(() =>
        useAppStore.setState({
          runtimeStatusByEnvironmentId: tracked(
            new Map([
              ...statuses,
              [`other-${i}`, { status: null, checkedAt: i, connectionGeneration: i }]
            ])
          )
        })
      )
      expect(view.result.current).toBe(settled)
    }
    expect(generationVisits).toBe(3 * hostCount)
    expect(bytes).toBeLessThanOrEqual(3 * hostCount * (capabilityBytes + 200))
    expect(visits).toBe(0)
    expect(renders).toBe(beforeRenders)
    expect(derive).not.toHaveBeenCalled()
    expect(supports).not.toHaveBeenCalled()
    const pending = Promise.withResolvers<boolean>()
    supports.mockReturnValue(pending.promise)
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ['chosen-0', { status: null, checkedAt: 1, connectionGeneration: 2 }]
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
          ['chosen-0', { status: null, checkedAt: 2, connectionGeneration: 3, hostContactEpoch: 1 }]
        ])
      })
    )
    await waitFor(() => expect(view.result.current.projects).toHaveLength(ready.length))
    const beforeRevisionChecks = supports.mock.calls.length
    await act(async () =>
      replaceRuntimeEnvironmentRevisions(
        Array.from({ length: hostCount }, (_, i) => ({
          id: `chosen-${i}`,
          createdAt: i === 0 ? 2 : 1
        }))
      )
    )
    await waitFor(() => expect(supports.mock.calls.length).toBeGreaterThan(beforeRevisionChecks))
    const beforeRetireChecks = supports.mock.calls.length
    await act(async () => replaceRuntimeEnvironmentRevisions([]))
    await waitFor(() => expect(supports.mock.calls.length).toBeGreaterThan(beforeRetireChecks))
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
  getStatus.mockResolvedValue({ capabilities: [AGENT_SESSION_CREATE_SURFACE_RUNTIME_CAPABILITY] })
  await act(async () => {
    await refreshLocalRuntimeCapabilities()
  })
  await waitFor(() => expect(view.result.current.projects).toHaveLength(1))
  view.unmount()
  setLocalRuntimeCapabilitiesForTests(null)
})
