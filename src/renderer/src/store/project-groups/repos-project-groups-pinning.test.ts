import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'
import {
  persistProjectGroupUpdate,
  persistProjectGroupUpdates
} from './project-group-update-persistence'

describe('repos and project groups pinning store actions', () => {
  const remoteGroup: ProjectGroup = {
    id: 'group-1',
    name: 'Group 1',
    parentPath: null,
    parentGroupId: null,
    executionHostId: 'runtime:env-1',
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }

  const remoteRepo: Repo = {
    id: 'repo-1',
    path: '/srv/repo-1',
    displayName: 'Repo 1',
    badgeColor: '#111111',
    addedAt: 1,
    executionHostId: 'runtime:env-1',
    projectGroupId: 'group-1'
  }

  const projectGroupsDelete = vi.fn()
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    projectGroupsDelete.mockResolvedValue(true)
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        repos: { update: vi.fn() },
        projectGroups: {
          create: vi.fn(),
          update: vi.fn(),
          delete: projectGroupsDelete
        },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
  })

  it('rejects group and repo pin updates when an older remote host ignores isPinned, and adopts when applied', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [remoteGroup],
      repos: [remoteRepo]
    })

    // Legacy remote ignores group isPinned
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...remoteGroup } }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('group-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().projectGroups[0]?.isPinned).toBeUndefined()

    // Compatible remote applies group isPinned
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...remoteGroup, isPinned: true } }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('group-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)
    expect(store.getState().projectGroups[0]?.isPinned).toBe(true)

    // Legacy remote ignores repo isPinned
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: { ...remoteRepo } }
    })
    await expect(
      store.getState().updateRepo('repo-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().repos[0]?.isPinned).toBeUndefined()

    // Compatible remote applies repo isPinned
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: { ...remoteRepo, isPinned: true } }
    })
    await expect(
      store.getState().updateRepo('repo-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)
    expect(store.getState().repos[0]?.isPinned).toBe(true)
  })

  it('rejects repo pin updates when the host returns null instead of merging locally', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [remoteGroup],
      repos: [remoteRepo]
    })
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: null }
    })

    await expect(
      store.getState().updateRepo('repo-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().repos[0]?.isPinned).toBeUndefined()
  })

  it('clears isPinned on contained repos when deleting a project group in the renderer cascade', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...remoteGroup, executionHostId: 'local' }],
      repos: [{ ...remoteRepo, executionHostId: 'local', isPinned: true }]
    })

    await expect(store.getState().deleteProjectGroup('group-1', { hostId: 'local' })).resolves.toBe(
      true
    )
    expect(store.getState().repos[0]).toMatchObject({
      projectGroupId: null,
      isPinned: false
    })
  })

  it('rejects group and repo unpin updates when an older remote host omits isPinned in the response', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...remoteGroup, isPinned: true }],
      repos: [{ ...remoteRepo, isPinned: true }]
    })

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...remoteGroup } }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('group-1', { isPinned: false }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().projectGroups[0]?.isPinned).toBe(true)

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: { ...remoteRepo } }
    })
    await expect(
      store.getState().updateRepo('repo-1', { isPinned: false }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().repos[0]?.isPinned).toBe(true)

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...remoteGroup, isPinned: false } }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('group-1', { isPinned: false }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)
    expect(store.getState().projectGroups[0]?.isPinned).toBe(false)

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: { ...remoteRepo, isPinned: false } }
    })
    await expect(
      store.getState().updateRepo('repo-1', { isPinned: false }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)
    expect(store.getState().repos[0]?.isPinned).toBe(false)
  })

  it('surfaces generic pin failure toasts when group or repo pin updates return null, lack a target, or reject', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const store = createTestStore()
      store.setState({
        projectGroups: [remoteGroup],
        repos: [remoteRepo]
      })

      // 1. Direct persistence helpers invoke onPinFailed when host returns null / omits group
      const onSinglePinFailed = vi.fn()
      runtimeEnvironmentCall.mockResolvedValueOnce({
        ok: true,
        result: { group: null }
      })
      await expect(
        persistProjectGroupUpdate(
          { kind: 'environment', environmentId: 'env-1' },
          'group-1',
          { isPinned: true },
          { onPinFailed: onSinglePinFailed }
        )
      ).resolves.toBeNull()
      expect(onSinglePinFailed).toHaveBeenCalledTimes(1)

      const onBatchPinFailed = vi.fn()
      runtimeEnvironmentCall.mockResolvedValueOnce({
        ok: true,
        result: { groups: [] }
      })
      await expect(
        persistProjectGroupUpdates(
          { kind: 'environment', environmentId: 'env-1' },
          [
            { groupId: 'group-1', updates: { isPinned: true } },
            { groupId: 'group-2', updates: { isPinned: true } }
          ],
          { onPinFailed: onBatchPinFailed }
        )
      ).resolves.toEqual([null, null])
      expect(onBatchPinFailed).toHaveBeenCalledTimes(1)

      // 2. Store group pin: missing target, null response, and rejected RPC each emit generic group-pin error without legacy description
      toastErrorSpy.mockClear()
      await expect(
        store.getState().updateProjectGroup('missing-group', { isPinned: true })
      ).resolves.toBe(false)
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
      expect(toastErrorSpy.mock.calls[0]).toEqual([expect.any(String)])

      toastErrorSpy.mockClear()
      runtimeEnvironmentCall.mockResolvedValueOnce({
        ok: true,
        result: { group: null }
      })
      await expect(
        store
          .getState()
          .updateProjectGroup('group-1', { isPinned: true }, { hostId: 'runtime:env-1' })
      ).resolves.toBe(false)
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
      expect(toastErrorSpy.mock.calls[0]).toEqual([expect.any(String)])

      toastErrorSpy.mockClear()
      runtimeEnvironmentCall.mockRejectedValueOnce(new Error('rpc disconnected'))
      await expect(
        store
          .getState()
          .updateProjectGroup('group-1', { isPinned: true }, { hostId: 'runtime:env-1' })
      ).resolves.toBe(false)
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
      expect(toastErrorSpy.mock.calls[0]).toEqual([expect.any(String)])

      // Returned group with mismatched isPinned still emits the specific capability description
      toastErrorSpy.mockClear()
      runtimeEnvironmentCall.mockResolvedValueOnce({
        ok: true,
        result: { group: { ...remoteGroup } }
      })
      await expect(
        store
          .getState()
          .updateProjectGroup('group-1', { isPinned: true }, { hostId: 'runtime:env-1' })
      ).resolves.toBe(false)
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
      expect(toastErrorSpy).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ description: expect.any(String) })
      )

      // 3. Store repo pin: missing repo, null response, and rejected RPC each emit generic project-pin error
      toastErrorSpy.mockClear()
      await expect(store.getState().updateRepo('missing-repo', { isPinned: true })).resolves.toBe(
        false
      )
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
      expect(toastErrorSpy.mock.calls[0]).toEqual([expect.any(String)])

      toastErrorSpy.mockClear()
      runtimeEnvironmentCall.mockResolvedValueOnce({
        ok: true,
        result: { repo: null }
      })
      await expect(
        store.getState().updateRepo('repo-1', { isPinned: true }, { hostId: 'runtime:env-1' })
      ).resolves.toBe(false)
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
      expect(toastErrorSpy.mock.calls[0]).toEqual([expect.any(String)])

      toastErrorSpy.mockClear()
      runtimeEnvironmentCall.mockRejectedValueOnce(new Error('rpc disconnected'))
      await expect(
        store.getState().updateRepo('repo-1', { isPinned: true }, { hostId: 'runtime:env-1' })
      ).resolves.toBe(false)
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
      expect(toastErrorSpy.mock.calls[0]).toEqual([expect.any(String)])
    } finally {
      toastErrorSpy.mockRestore()
      consoleErrorSpy.mockRestore()
    }
  })

  it('reconciles cleared isPinned from a committed Stage-1 remote parent move without clobbering concurrent renames', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const store = createTestStore()
      const pinnedChild: ProjectGroup = {
        ...remoteGroup,
        id: 'child-pin',
        name: 'Initial Name',
        parentGroupId: 'parent-1',
        isPinned: true
      }
      store.setState({ projectGroups: [pinnedChild], repos: [] })

      let rejectOrderStage!: (reason?: unknown) => void
      runtimeEnvironmentCall
        .mockResolvedValueOnce({
          ok: true,
          result: {
            group: {
              ...pinnedChild,
              parentGroupId: null,
              isPinned: false,
              updatedAt: 2
            }
          }
        })
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectOrderStage = reject
            })
        )

      const pending = store
        .getState()
        .updateProjectGroup(
          'child-pin',
          { parentGroupId: null, tabOrder: 3 },
          { hostId: 'runtime:env-1' }
        )
      await vi.waitFor(() => {
        expect(typeof rejectOrderStage).toBe('function')
      })
      store.setState((s) => ({
        projectGroups: s.projectGroups.map((entry) =>
          entry.id === 'child-pin' ? { ...entry, name: 'Concurrent Rename' } : entry
        )
      }))
      rejectOrderStage(new Error('stage 2 failed'))

      await expect(pending).resolves.toBe(false)
      expect(store.getState().projectGroups[0]).toMatchObject({
        id: 'child-pin',
        parentGroupId: null,
        isPinned: false,
        name: 'Concurrent Rename'
      })
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('does not overwrite a newer concurrent isPinned update when an older parent move fails at Stage 2', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const store = createTestStore()
      const pinnedChild: ProjectGroup = {
        ...remoteGroup,
        id: 'child-pin-race',
        parentGroupId: 'parent-1',
        isPinned: true
      }
      store.setState({ projectGroups: [pinnedChild], repos: [] })

      let rejectMoveStage2!: (reason?: unknown) => void
      runtimeEnvironmentCall
        .mockResolvedValueOnce({
          ok: true,
          result: {
            group: {
              ...pinnedChild,
              parentGroupId: null,
              isPinned: false,
              updatedAt: 2
            }
          }
        })
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectMoveStage2 = reject
            })
        )
        .mockResolvedValueOnce({
          ok: true,
          result: {
            group: {
              ...pinnedChild,
              parentGroupId: null,
              isPinned: true,
              updatedAt: 2
            }
          }
        })

      const movePromise = store
        .getState()
        .updateProjectGroup(
          'child-pin-race',
          { parentGroupId: null, tabOrder: 4 },
          { hostId: 'runtime:env-1' }
        )
      await vi.waitFor(() => {
        expect(typeof rejectMoveStage2).toBe('function')
      })

      await expect(
        store
          .getState()
          .updateProjectGroup('child-pin-race', { isPinned: true }, { hostId: 'runtime:env-1' })
      ).resolves.toBe(true)
      expect(store.getState().projectGroups[0]?.isPinned).toBe(true)

      rejectMoveStage2(new Error('stage 2 failed'))
      await expect(movePromise).resolves.toBe(false)
      expect(store.getState().projectGroups[0]).toMatchObject({
        id: 'child-pin-race',
        parentGroupId: null,
        isPinned: true
      })
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })
})
