import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { makeLineage, makeWorkspaceLineage } from './workspace-lineage.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createLocalLineageTestStore,
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../worktrees-slice-test-harness'

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

describe('worktree lineage state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('preserves the other host lineage when refreshing local lineage', async () => {
    const store = createTestStore()
    const localWorktree = makeWorktree({
      id: 'repo1::/local/child',
      repoId: 'repo1',
      hostId: LOCAL_EXECUTION_HOST_ID
    })
    const sshWorktree = makeWorktree({
      id: 'repo2::/ssh/child',
      repoId: 'repo2',
      hostId: 'ssh:ssh-1'
    })
    const localLineage = makeLineage({
      worktreeId: localWorktree.id,
      parentWorktreeId: 'repo1::/local/parent',
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      taskId: 'task-local',
      coordinatorHandle: 'coord-local'
    })
    const sshLineage = makeLineage({
      worktreeId: sshWorktree.id,
      parentWorktreeId: 'repo2::/ssh/parent',
      capture: { source: 'cwd-context', confidence: 'inferred' },
      taskId: 'task-ssh',
      coordinatorHandle: 'coord-ssh'
    })
    const localWorkspace = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(localWorktree.id),
      parentWorkspaceKey: worktreeWorkspaceKey(localLineage.parentWorktreeId),
      childInstanceId: localLineage.worktreeInstanceId,
      parentInstanceId: localLineage.parentWorktreeInstanceId,
      origin: localLineage.origin,
      capture: localLineage.capture,
      taskId: localLineage.taskId,
      coordinatorHandle: localLineage.coordinatorHandle
    })
    const sshWorkspace = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(sshWorktree.id),
      parentWorkspaceKey: worktreeWorkspaceKey(sshLineage.parentWorktreeId),
      childInstanceId: sshLineage.worktreeInstanceId,
      parentInstanceId: sshLineage.parentWorktreeInstanceId,
      origin: sshLineage.origin,
      capture: sshLineage.capture,
      taskId: sshLineage.taskId,
      coordinatorHandle: sshLineage.coordinatorHandle
    })
    store.setState({
      worktreesByRepo: {
        repo1: [localWorktree],
        repo2: [sshWorktree]
      },
      worktreeLineageById: {
        [localWorktree.id]: localLineage,
        [sshWorktree.id]: sshLineage
      },
      workspaceLineageByChildKey: {
        [localWorkspace.childWorkspaceKey]: localWorkspace,
        [sshWorkspace.childWorkspaceKey]: sshWorkspace
      }
    } as Partial<AppState>)
    const payload = {
      lineage: { [localWorktree.id]: localLineage },
      workspaceLineage: { [localWorkspace.childWorkspaceKey]: localWorkspace }
    }
    mockApi.worktrees.listLineage.mockImplementation(async () => structuredClone(payload))

    await store.getState().fetchWorktreeLineage()

    expect(store.getState().worktreeLineageById['repo1::/local/child']).toMatchObject({
      parentWorktreeId: 'repo1::/local/parent',
      taskId: 'task-local',
      coordinatorHandle: 'coord-local'
    })
    expect(store.getState().worktreeLineageById['repo2::/ssh/child']).toMatchObject({
      parentWorktreeId: 'repo2::/ssh/parent',
      taskId: 'task-ssh',
      coordinatorHandle: 'coord-ssh'
    })
    expect(store.getState().workspaceLineageByChildKey['worktree:repo2::/ssh/child']).toMatchObject(
      {
        parentWorkspaceKey: 'worktree:repo2::/ssh/parent',
        taskId: 'task-ssh',
        coordinatorHandle: 'coord-ssh'
      }
    )
  })

  it('clears inline local lineage immediately when an inline-only child is unnested', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    const parent = {
      ...makeWorktree({
        id: lineage.parentWorktreeId,
        instanceId: lineage.parentWorktreeInstanceId,
        repoId: 'repo1'
      }),
      childWorktreeIds: [lineage.worktreeId],
      lineage: null
    }
    const child = {
      ...makeWorktree({
        id: lineage.worktreeId,
        instanceId: lineage.worktreeInstanceId,
        repoId: 'repo1'
      }),
      parentWorktreeId: lineage.parentWorktreeId,
      childWorktreeIds: [],
      lineage
    }
    mockApi.worktrees.updateLineage.mockResolvedValue({ lineage: null, workspaceLineage: null })
    store.setState({
      worktreesByRepo: { repo1: [parent, child] },
      worktreeLineageById: {}
    } as Partial<AppState>)

    await store.getState().updateWorktreeLineage(child.id, { noParent: true })

    expect(store.getState().worktreesByRepo.repo1).toMatchObject([
      { id: parent.id, childWorktreeIds: [] },
      { id: child.id, parentWorktreeId: null, lineage: null }
    ])
  })

  it('syncs workspace lineage when a child is manually reparented', async () => {
    const lineage = makeLineage({
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' }
    })
    const store = createLocalLineageTestStore(lineage)
    const oldWorkspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(lineage.worktreeId),
      parentWorkspaceKey: folderWorkspaceKey('folder-1')
    })
    mockApi.worktrees.updateLineage.mockResolvedValue({ lineage })
    store.setState({
      workspaceLineageByChildKey: { [oldWorkspaceLineage.childWorkspaceKey]: oldWorkspaceLineage }
    } as Partial<AppState>)

    await store.getState().updateWorktreeLineage(lineage.worktreeId, {
      parentWorktreeId: lineage.parentWorktreeId
    })

    expect(store.getState().workspaceLineageByChildKey).toEqual({
      'worktree:repo1::/path/child': {
        childWorkspaceKey: 'worktree:repo1::/path/child',
        childInstanceId: 'child-instance',
        parentWorkspaceKey: 'worktree:repo1::/path/parent',
        parentInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    })
  })

  it('keeps a folder workspace parent the host reports when the worktree lineage is cleared', async () => {
    const lineage = makeLineage()
    const store = createLocalLineageTestStore(lineage)
    const folderParent = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(lineage.worktreeId),
      parentWorkspaceKey: folderWorkspaceKey('folder-9'),
      parentInstanceId: 'folder-9'
    })
    mockApi.worktrees.updateLineage.mockResolvedValue({
      lineage: null,
      workspaceLineage: folderParent
    })

    await store.getState().assignWorktreeParent(lineage.worktreeId, {
      parentWorktreeId: folderWorkspaceKey('folder-9')
    })

    expect(store.getState().worktreeLineageById[lineage.worktreeId]).toBeUndefined()
    expect(
      store.getState().workspaceLineageByChildKey[worktreeWorkspaceKey(lineage.worktreeId)]
    ).toEqual(folderParent)
  })

  it('assigns a parent through the worktree owner runtime when host-stamped', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    const child = makeWorktree({
      id: lineage.worktreeId,
      repoId: 'repo1',
      path: '/remote/child',
      hostId: 'runtime:owner-env'
    })
    const updatedChild = { ...child, lineage }
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-owner-runtime-assign-parent',
      ok: true,
      result: { worktree: updatedChild },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      worktreesByRepo: { repo1: [child] }
    } as Partial<AppState>)

    await store.getState().assignWorktreeParent(lineage.worktreeId, {
      parentWorktreeId: lineage.parentWorktreeId
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'owner-env',
      method: 'worktree.set',
      params: {
        worktree: `id:${lineage.worktreeId}`,
        parentWorktree: `id:${lineage.parentWorktreeId}`
      },
      timeoutMs: 15_000
    })
  })

  it("assigns a parent on the clicked twin's own host, not its same-id twin", async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    const localTwin = makeWorktree({
      id: lineage.worktreeId,
      repoId: 'repo1',
      path: '/local/child',
      hostId: LOCAL_EXECUTION_HOST_ID
    })
    const serverTwin = makeWorktree({
      id: lineage.worktreeId,
      repoId: 'repo1',
      path: '/remote/child',
      hostId: 'runtime:owner-env'
    })
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-twin-assign-parent',
      ok: true,
      result: { worktree: { ...serverTwin, lineage } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({ worktreesByRepo: { repo1: [localTwin, serverTwin] } })

    await store.getState().assignWorktreeParent(lineage.worktreeId, {
      parentWorktreeId: lineage.parentWorktreeId,
      executionHostId: 'runtime:owner-env'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'owner-env',
      method: 'worktree.set',
      params: {
        worktree: `id:${lineage.worktreeId}`,
        parentWorktree: `id:${lineage.parentWorktreeId}`
      },
      timeoutMs: 15_000
    })
  })

  it('refreshes assignment failures through the worktree owner runtime when host-stamped', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    const child = makeWorktree({
      id: lineage.worktreeId,
      repoId: 'repo1',
      path: '/remote/child',
      hostId: 'runtime:owner-env'
    })
    runtimeEnvironmentCall
      .mockRejectedValueOnce(new Error('owner assignment failed'))
      .mockResolvedValueOnce({
        id: 'rpc-owner-runtime-lineage-refresh',
        ok: true,
        result: { lineage: { [lineage.worktreeId]: lineage } },
        _meta: { runtimeId: 'runtime-remote' }
      })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      worktreesByRepo: { repo1: [child] }
    } as Partial<AppState>)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      store.getState().assignWorktreeParent(lineage.worktreeId, {
        parentWorktreeId: lineage.parentWorktreeId
      })
    ).rejects.toThrow('owner assignment failed')

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'owner-env',
      method: 'worktree.lineageList',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
  })

  it('removes stale owner-runtime lineage when host-stamped worktrees refresh empty', async () => {
    const store = createTestStore()
    const staleLineage = makeLineage()
    const staleWorkspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(staleLineage.worktreeId)
    })
    const child = makeWorktree({
      id: staleLineage.worktreeId,
      repoId: 'repo1',
      path: '/remote/child',
      hostId: 'runtime:owner-env'
    })
    runtimeEnvironmentCall
      .mockRejectedValueOnce(new Error('owner assignment failed'))
      .mockResolvedValueOnce({
        id: 'rpc-owner-runtime-lineage-refresh',
        ok: true,
        result: { lineage: {}, workspaceLineage: {} },
        _meta: { runtimeId: 'runtime-remote' }
      })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      worktreesByRepo: { repo1: [child] },
      worktreeLineageById: { [staleLineage.worktreeId]: staleLineage },
      workspaceLineageByChildKey: {
        [staleWorkspaceLineage.childWorkspaceKey]: staleWorkspaceLineage
      }
    } as Partial<AppState>)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      store.getState().assignWorktreeParent(staleLineage.worktreeId, {
        parentWorktreeId: staleLineage.parentWorktreeId
      })
    ).rejects.toThrow('owner assignment failed')

    expect(store.getState().worktreeLineageById).toEqual({})
    expect(store.getState().workspaceLineageByChildKey).toEqual({})
  })

  it('clears lineage through the active remote runtime environment', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    const child = makeWorktree({
      id: lineage.worktreeId,
      repoId: 'repo1',
      path: '/remote/child',
      lineage
    } as Partial<Worktree> & { id: string; repoId: string })
    // Why: ingest stamps a server's rows; routing follows the stamp, not focus.
    child.hostId = 'runtime:env-1'
    const updatedChild = { ...child, lineage: null }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-clear-lineage',
      ok: true,
      result: { worktree: updatedChild },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [child] },
      worktreeLineageById: { [lineage.worktreeId]: lineage },
      sortEpoch: 3
    } as Partial<AppState>)

    await store.getState().updateWorktreeLineage(lineage.worktreeId, { noParent: true })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.set',
      params: { worktree: `id:${lineage.worktreeId}`, noParent: true },
      timeoutMs: 15_000
    })
    expect(store.getState().worktreeLineageById).toEqual({})
    expect(store.getState().worktreesByRepo.repo1?.[0]).toEqual({
      ...updatedChild,
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1'
    })
  })

  it('rethrows the original assign failure when the recovery refresh fails', async () => {
    const lineage = makeLineage()
    const store = createLocalLineageTestStore(lineage)
    mockApi.worktrees.updateLineage.mockRejectedValueOnce(new Error('stale parent'))
    mockApi.worktrees.listLineage.mockRejectedValueOnce(new Error('refresh failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // A failed recovery refresh must not replace the cause the caller toasts.
    await expect(
      store.getState().assignWorktreeParent(lineage.worktreeId, {
        parentWorktreeId: lineage.parentWorktreeId
      })
    ).rejects.toThrow('stale parent')
  })
})
