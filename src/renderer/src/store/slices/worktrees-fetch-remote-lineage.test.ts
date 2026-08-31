import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control-huge-repo-warning-dismissals'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeLineage, makeWorkspaceLineage, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    clearHugeRepoWarningDismissalsForTests()
  })

  it('updates remote worktree records when only lineage changes', async () => {
    const store = createTestStore()
    const initial = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    const lineage = makeLineage({ worktreeId: initial.id })
    const refreshed = { ...initial, lineage }
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [initial] },
      sortEpoch: 7
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? { lineage: { [lineage.worktreeId]: lineage } }
          : makeDetectedResult('repo1', [refreshed])
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('updates worktree records when only GitLab link metadata changes', async () => {
    const store = createTestStore()
    const initial = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature'
    })
    const refreshed = { ...initial, linkedGitLabIssue: 321 }
    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({
      worktreesByRepo: { repo1: [initial] },
      sortEpoch: 7
    } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('refreshes remote lineage when the worktree payload is otherwise unchanged', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    const staleLineage = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/old-parent'
    })
    const freshLineage = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/new-parent'
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: { [worktree.id]: staleLineage },
      sortEpoch: 7
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? { lineage: { [freshLineage.worktreeId]: freshLineage } }
          : makeDetectedResult('repo1', [worktree])
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([worktree])
    expect(store.getState().worktreeLineageById).toEqual({
      [freshLineage.worktreeId]: freshLineage
    })
    expect(store.getState().sortEpoch).toBe(7)
  })

  it('keeps remote lineage map identity when a cloned payload is unchanged', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1'
    })
    const lineage = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/parent',
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      taskId: 'task-42',
      coordinatorHandle: 'coord-1'
    })
    const workspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
      parentWorkspaceKey: worktreeWorkspaceKey(lineage.parentWorktreeId),
      childInstanceId: lineage.worktreeInstanceId,
      parentInstanceId: lineage.parentWorktreeInstanceId,
      origin: lineage.origin,
      capture: lineage.capture,
      taskId: lineage.taskId,
      coordinatorHandle: lineage.coordinatorHandle,
      createdAt: lineage.createdAt
    })
    const detected = makeDetectedResult('repo1', [worktree])
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      detectedWorktreesByRepo: { repo1: detected },
      worktreeLineageById: { [lineage.worktreeId]: lineage },
      workspaceLineageByChildKey: {
        [workspaceLineage.childWorkspaceKey]: workspaceLineage
      },
      sortEpoch: 7
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? structuredClone({
              lineage: { [lineage.worktreeId]: lineage },
              workspaceLineage: { [workspaceLineage.childWorkspaceKey]: workspaceLineage }
            })
          : structuredClone(detected)
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })
    const before = store.getState()

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreeLineageById).toBe(before.worktreeLineageById)
    expect(store.getState().workspaceLineageByChildKey).toBe(before.workspaceLineageByChildKey)
    expect(store.getState().worktreeLineageById[lineage.worktreeId]).toBe(lineage)
    expect(store.getState().workspaceLineageByChildKey[workspaceLineage.childWorkspaceKey]).toBe(
      workspaceLineage
    )
  })

  it('defers remote lineage when a caller owns the final host refresh', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    const lineage = makeLineage({ worktreeId: worktree.id })
    const workspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worktree.id)
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: {}
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? {
              lineage: { [lineage.worktreeId]: lineage },
              workspaceLineage: { [workspaceLineage.childWorkspaceKey]: workspaceLineage }
            }
          : makeDetectedResult('repo1', [worktree])
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })

    await store.getState().fetchWorktrees('repo1', {
      executionHostId: 'runtime:env-1',
      suppressRemoteLineageRefresh: true
    })

    expect(store.getState().worktreesByRepo.repo1).toEqual([
      expect.objectContaining({ id: worktree.id, hostId: 'runtime:env-1' })
    ])
    expect(
      runtimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'worktree.lineageList'
      )
    ).toHaveLength(0)

    await store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })

    expect(
      runtimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'worktree.lineageList'
      )
    ).toHaveLength(1)
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
    expect(store.getState().workspaceLineageByChildKey).toEqual({
      [workspaceLineage.childWorkspaceKey]: workspaceLineage
    })
  })

  it('keeps a lineage row written while the host lineage request was in flight', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1'
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    } as Partial<AppState>)

    let releaseLineage: (() => void) | undefined
    const lineageReplied = new Promise<void>((resolve) => {
      releaseLineage = resolve
    })
    runtimeEnvironmentCall.mockImplementation(async ({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.lineageList') {
        await lineageReplied
        return {
          id: 'rpc-1',
          ok: true,
          result: { lineage: {}, workspaceLineage: {} },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-2',
        ok: true,
        result: makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    const pending = store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })
    const created = makeLineage({ worktreeId: worktree.id })
    const createdWorkspace = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worktree.id)
    })
    store.setState({
      worktreeLineageById: { [created.worktreeId]: created },
      workspaceLineageByChildKey: { [createdWorkspace.childWorkspaceKey]: createdWorkspace }
    } as Partial<AppState>)

    releaseLineage?.()
    await pending

    expect(store.getState().worktreeLineageById).toEqual({ [created.worktreeId]: created })
    expect(store.getState().workspaceLineageByChildKey).toEqual({
      [createdWorkspace.childWorkspaceKey]: createdWorkspace
    })
  })

  it('keeps a parent reassignment written while the host lineage request was in flight', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1'
    })
    const childKey = worktreeWorkspaceKey(worktree.id)
    const before = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/old-parent'
    })
    const beforeWorkspace = makeWorkspaceLineage({
      childWorkspaceKey: childKey,
      parentWorkspaceKey: worktreeWorkspaceKey('repo1::/remote/old-parent')
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: { [before.worktreeId]: before },
      workspaceLineageByChildKey: { [childKey]: beforeWorkspace }
    } as Partial<AppState>)

    let releaseLineage: (() => void) | undefined
    const lineageReplied = new Promise<void>((resolve) => {
      releaseLineage = resolve
    })
    runtimeEnvironmentCall.mockImplementation(async ({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.lineageList') {
        await lineageReplied
        return {
          id: 'rpc-1',
          ok: true,
          result: {
            lineage: { [before.worktreeId]: before },
            workspaceLineage: { [childKey]: beforeWorkspace }
          },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-2',
        ok: true,
        result: makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    const pending = store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })
    const reassigned = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/new-parent'
    })
    const reassignedWorkspace = makeWorkspaceLineage({
      childWorkspaceKey: childKey,
      parentWorkspaceKey: worktreeWorkspaceKey('repo1::/remote/new-parent')
    })
    store.setState({
      worktreeLineageById: { [reassigned.worktreeId]: reassigned },
      workspaceLineageByChildKey: { [childKey]: reassignedWorkspace }
    } as Partial<AppState>)

    releaseLineage?.()
    await pending

    expect(store.getState().worktreeLineageById).toEqual({ [reassigned.worktreeId]: reassigned })
    expect(store.getState().workspaceLineageByChildKey).toEqual({ [childKey]: reassignedWorkspace })
  })

  it('keeps a lineage row deleted while the host lineage request was in flight', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1'
    })
    const childKey = worktreeWorkspaceKey(worktree.id)
    const before = makeLineage({ worktreeId: worktree.id })
    const beforeWorkspace = makeWorkspaceLineage({ childWorkspaceKey: childKey })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: { [before.worktreeId]: before },
      workspaceLineageByChildKey: { [childKey]: beforeWorkspace }
    } as Partial<AppState>)

    let releaseLineage: (() => void) | undefined
    const lineageReplied = new Promise<void>((resolve) => {
      releaseLineage = resolve
    })
    runtimeEnvironmentCall.mockImplementation(async ({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.lineageList') {
        await lineageReplied
        return {
          id: 'rpc-1',
          ok: true,
          result: {
            lineage: { [before.worktreeId]: before },
            workspaceLineage: { [childKey]: beforeWorkspace }
          },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-2',
        ok: true,
        result: makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    const pending = store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })
    store.setState({
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    } as Partial<AppState>)

    releaseLineage?.()
    await pending

    expect(store.getState().worktreeLineageById).toEqual({})
    expect(store.getState().workspaceLineageByChildKey).toEqual({})
  })

  it('drops a host lineage row the refresh reply no longer reports', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'runtime:env-1'
    })
    const stale = makeLineage({ worktreeId: worktree.id })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: { [stale.worktreeId]: stale }
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result:
          method === 'worktree.lineageList'
            ? { lineage: {}, workspaceLineage: {} }
            : makeDetectedResult('repo1', [worktree]),
        _meta: { runtimeId: 'runtime-remote' }
      })
    )

    await store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })

    expect(store.getState().worktreeLineageById).toEqual({})
  })

  it('keeps a successful remote worktree refresh when lineage refresh fails', async () => {
    const store = createTestStore()
    const refreshed = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    const staleLineage = makeLineage({ worktreeId: refreshed.id })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: {},
      worktreeLineageById: { [staleLineage.worktreeId]: staleLineage },
      sortEpoch: 7
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.lineageList') {
        return Promise.reject(new Error('lineage timeout'))
      }
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result: makeDetectedResult('repo1', [refreshed]),
        _meta: { runtimeId: 'runtime-remote' }
      })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([
      {
        ...refreshed,
        hostId: 'runtime:env-1',
        runtimeOwnerEnvironmentId: 'env-1'
      }
    ])
    expect(store.getState().worktreeLineageById).toEqual({
      [staleLineage.worktreeId]: staleLineage
    })
    expect(store.getState().sortEpoch).toBe(8)
  })
})
