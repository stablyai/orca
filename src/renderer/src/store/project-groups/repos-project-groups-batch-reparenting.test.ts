import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'

describe('updateProjectGroup reparenting and batch fencing', () => {
  const folderScanGroup: ProjectGroup = {
    id: 'group-1',
    name: 'Projects',
    parentPath: '/srv/projects',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }

  const projectGroupsUpdate = vi.fn()
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    projectGroupsUpdate.mockResolvedValue(null)
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        repos: {},
        projectGroups: {
          update: projectGroupsUpdate
        },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
  })

  it('commits parentGroupId before order fields on remote hosts so an older host rejecting parentGroupId never mutates tabOrder', async () => {
    const parentGroup: ProjectGroup = {
      ...folderScanGroup,
      id: 'parent-1',
      name: 'Parent',
      parentPath: null,
      createdFrom: 'manual',
      executionHostId: 'runtime:env-1'
    }
    const childCandidate: ProjectGroup = {
      ...parentGroup,
      id: 'child-1',
      name: 'Child',
      parentGroupId: null,
      tabOrder: 1
    }
    const store = createTestStore()
    store.setState({ projectGroups: [parentGroup, childCandidate] })

    // 1. Older remote host strips parentGroupId -> only parentGroupId was sent; tabOrder was never sent
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...childCandidate, parentGroupId: null, tabOrder: 1 } }
    })
    const rejected = await store
      .getState()
      .updateProjectGroup('child-1', { parentGroupId: 'parent-1', tabOrder: 0 })
    expect(rejected).toBe(false)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'projectGroup.update',
        params: { groupId: 'child-1', updates: { parentGroupId: 'parent-1' } }
      })
    )
    expect(store.getState().projectGroups.find((group) => group.id === 'child-1')).toMatchObject({
      parentGroupId: null,
      tabOrder: 1
    })

    // 2. Compatible remote host accepts parentGroupId first, then applies tabOrder
    runtimeEnvironmentCall.mockClear()
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        ok: true,
        result: { group: { ...childCandidate, parentGroupId: 'parent-1', tabOrder: 1 } }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { group: { ...childCandidate, parentGroupId: 'parent-1', tabOrder: 0 } }
      })
    const accepted = await store
      .getState()
      .updateProjectGroup('child-1', { parentGroupId: 'parent-1', tabOrder: 0 })
    expect(accepted).toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'projectGroup.update',
        params: { groupId: 'child-1', updates: { parentGroupId: 'parent-1' } }
      })
    )
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'projectGroup.update',
        params: { groupId: 'child-1', updates: { tabOrder: 0 } }
      })
    )
    expect(store.getState().projectGroups.find((group) => group.id === 'child-1')).toMatchObject({
      parentGroupId: 'parent-1',
      tabOrder: 0
    })
  })

  it('shows parent-move rejection toast when reparenting with rootProjectOrder against an older remote host lacking root-order capability', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '')
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'status.get') {
        const base = createCompatibleRuntimeStatusResponse()
        return Promise.resolve({
          ...base,
          result: { ...base.result, capabilities: [] }
        })
      }
      return runtimeEnvironmentCall(args)
    })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        {
          ...folderScanGroup,
          id: 'sub-1',
          parentGroupId: 'group-1',
          executionHostId: 'runtime:env-1'
        }
      ]
    })

    const accepted = await store
      .getState()
      .updateProjectGroup('sub-1', { parentGroupId: null, tabOrder: 0, rootProjectOrder: 1000 })

    expect(accepted).toBe(false)
    expect(toastErrorSpy).toHaveBeenCalledTimes(1)
    toastErrorSpy.mockRestore()
  })

  it('reconciles committed parentGroupId into renderer state when the follow-up order stage or a sibling parent stage fails on a remote host', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const parentGroup: ProjectGroup = {
      ...folderScanGroup,
      id: 'parent-1',
      name: 'Parent',
      parentPath: null,
      createdFrom: 'manual',
      executionHostId: 'runtime:env-1'
    }
    const childCandidate: ProjectGroup = {
      ...parentGroup,
      id: 'child-1',
      name: 'Child',
      parentGroupId: null,
      tabOrder: 4
    }
    const childTwo: ProjectGroup = {
      ...parentGroup,
      id: 'child-2',
      name: 'Child 2',
      parentGroupId: null,
      tabOrder: 5
    }
    const store = createTestStore()
    store.setState({ projectGroups: [parentGroup, childCandidate, childTwo] })

    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        ok: true,
        result: { group: { ...childCandidate, parentGroupId: 'parent-1', tabOrder: 4 } }
      })
      .mockRejectedValueOnce(new Error('network timeout on order stage'))

    const accepted = await store
      .getState()
      .updateProjectGroup('child-1', { parentGroupId: 'parent-1', tabOrder: 0 })

    expect(accepted).toBe(false)
    expect(store.getState().projectGroups.find((group) => group.id === 'child-1')).toMatchObject({
      parentGroupId: 'parent-1',
      tabOrder: 4,
      executionHostId: 'runtime:env-1'
    })

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: {
        groups: [{ ...childTwo, parentGroupId: 'parent-1', tabOrder: 5 }]
      }
    })
    const batchAccepted = await store.getState().updateProjectGroups([
      {
        groupId: 'child-2',
        updates: { parentGroupId: 'parent-1', tabOrder: 1 },
        hostId: 'runtime:env-1'
      },
      {
        groupId: 'child-1',
        updates: { parentGroupId: null, tabOrder: 2 },
        hostId: 'runtime:env-1'
      }
    ])

    expect(batchAccepted).toBe(false)
    expect(store.getState().projectGroups.find((group) => group.id === 'child-2')).toMatchObject({
      parentGroupId: 'parent-1',
      tabOrder: 5,
      executionHostId: 'runtime:env-1'
    })

    let rejectOrderStage!: (reason?: unknown) => void
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        ok: true,
        result: {
          group: { ...childCandidate, name: 'Old Name', parentGroupId: null, tabOrder: 4 }
        }
      })
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOrderStage = reject
          })
      )

    const pendingMove = store
      .getState()
      .updateProjectGroup('child-1', { parentGroupId: null, tabOrder: 0 })
    await vi.waitFor(() => {
      expect(typeof rejectOrderStage).toBe('function')
    })
    store.setState((s) => ({
      projectGroups: s.projectGroups.map((entry) =>
        entry.id === 'child-1' ? { ...entry, name: 'Renamed While In Flight' } : entry
      )
    }))
    rejectOrderStage(new Error('order stage failed after concurrent rename'))

    expect(await pendingMove).toBe(false)
    expect(store.getState().projectGroups.find((group) => group.id === 'child-1')).toMatchObject({
      parentGroupId: null,
      name: 'Renamed While In Flight',
      tabOrder: 4
    })

    let rejectMoveAOrderStage!: (reason?: unknown) => void
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        ok: true,
        result: {
          group: { ...childCandidate, parentGroupId: 'parent-1', tabOrder: 4 }
        }
      })
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectMoveAOrderStage = reject
          })
      )
      .mockResolvedValueOnce({
        ok: true,
        result: {
          group: { ...childCandidate, parentGroupId: null, tabOrder: 9 }
        }
      })

    const moveA = store
      .getState()
      .updateProjectGroup('child-1', { parentGroupId: 'parent-1', tabOrder: 0 })
    await vi.waitFor(() => {
      expect(typeof rejectMoveAOrderStage).toBe('function')
    })
    expect(await store.getState().updateProjectGroup('child-1', { parentGroupId: null })).toBe(true)
    rejectMoveAOrderStage(new Error('move A order stage failed after move B succeeded'))

    expect(await moveA).toBe(false)
    expect(store.getState().projectGroups.find((group) => group.id === 'child-1')).toMatchObject({
      parentGroupId: null,
      tabOrder: 9
    })
    consoleErrorSpy.mockRestore()
  })

  it('does not let a slower multi-host batch overwrite a newer committed group update', async () => {
    const localGroup: ProjectGroup = {
      ...folderScanGroup,
      id: 'local-1',
      name: 'Local Initial',
      executionHostId: 'local',
      updatedAt: 1
    }
    const remoteGroup: ProjectGroup = {
      ...folderScanGroup,
      id: 'remote-1',
      name: 'Remote Initial',
      executionHostId: 'runtime:env-1',
      updatedAt: 1
    }
    const store = createTestStore()
    store.setState({ projectGroups: [localGroup, remoteGroup] })

    const pendingLocalUpdate = Promise.withResolvers<ProjectGroup>()
    const remoteBatchFinished = Promise.withResolvers<void>()
    projectGroupsUpdate.mockImplementationOnce(() => pendingLocalUpdate.promise)
    runtimeEnvironmentCall
      .mockImplementationOnce(async () => {
        queueMicrotask(() => remoteBatchFinished.resolve())
        return {
          ok: true,
          result: {
            group: { ...remoteGroup, name: 'Stale Multi-Host Batch', updatedAt: 2 }
          }
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          group: { ...remoteGroup, name: 'Newer Single Update', updatedAt: 2 }
        }
      })

    const multiHostPromise = store.getState().updateProjectGroups([
      { groupId: 'local-1', updates: { name: 'Local Done' }, hostId: 'local' },
      {
        groupId: 'remote-1',
        updates: { name: 'Stale Multi-Host Batch' },
        hostId: 'runtime:env-1'
      }
    ])
    await remoteBatchFinished.promise

    expect(
      await store.getState().updateProjectGroup('remote-1', { name: 'Newer Single Update' })
    ).toBe(true)
    expect(store.getState().projectGroups.find((group) => group.id === 'remote-1')?.name).toBe(
      'Newer Single Update'
    )

    pendingLocalUpdate.resolve({ ...localGroup, name: 'Local Done', updatedAt: 2 })
    expect(await multiHostPromise).toBe(true)
    expect(store.getState().projectGroups.find((group) => group.id === 'local-1')?.name).toBe(
      'Local Done'
    )
    expect(store.getState().projectGroups.find((group) => group.id === 'remote-1')?.name).toBe(
      'Newer Single Update'
    )

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const parentGroup: ProjectGroup = {
      ...folderScanGroup,
      id: 'parent-r',
      executionHostId: 'runtime:env-1'
    }
    store.setState({ projectGroups: [localGroup, remoteGroup, parentGroup] })
    const pendingLocalSecond = Promise.withResolvers<ProjectGroup>()
    const remoteRenameDone = Promise.withResolvers<void>()
    let rejectStage2!: (reason?: unknown) => void
    projectGroupsUpdate.mockImplementationOnce(() => pendingLocalSecond.promise)
    runtimeEnvironmentCall
      .mockImplementationOnce(async () => {
        queueMicrotask(() => remoteRenameDone.resolve())
        return {
          ok: true,
          result: { group: { ...remoteGroup, name: 'Batch Rename', updatedAt: 3 } }
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          group: {
            ...remoteGroup,
            name: 'Batch Rename',
            parentGroupId: 'parent-r',
            updatedAt: 3
          }
        }
      })
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectStage2 = reject
          })
      )

    const renameBatch = store.getState().updateProjectGroups([
      { groupId: 'local-1', updates: { name: 'Local 2' }, hostId: 'local' },
      { groupId: 'remote-1', updates: { name: 'Batch Rename' }, hostId: 'runtime:env-1' }
    ])
    await remoteRenameDone.promise

    const stagedMove = store
      .getState()
      .updateProjectGroup('remote-1', { parentGroupId: 'parent-r', tabOrder: 0 })
    await vi.waitFor(() => {
      expect(typeof rejectStage2).toBe('function')
    })

    pendingLocalSecond.resolve({ ...localGroup, name: 'Local 2', updatedAt: 3 })
    expect(await renameBatch).toBe(true)
    expect(store.getState().projectGroups.find((group) => group.id === 'remote-1')).toMatchObject({
      name: 'Batch Rename',
      parentGroupId: 'parent-r'
    })
    rejectStage2(new Error('stage 2 timeout'))
    expect(await stagedMove).toBe(false)

    expect(store.getState().projectGroups.find((group) => group.id === 'remote-1')).toMatchObject({
      name: 'Batch Rename',
      parentGroupId: 'parent-r'
    })

    // Older rename returning after a newer Stage-1 parent commit must not suppress Stage-1 reconciliation when Stage-2 fails.
    store.setState({ projectGroups: [localGroup, remoteGroup, parentGroup] })
    const delayedRename = Promise.withResolvers<ProjectGroup>()
    const stage1Done = Promise.withResolvers<void>()
    let rejectNewerStage2!: (reason?: unknown) => void
    runtimeEnvironmentCall
      .mockImplementationOnce(async () => ({
        ok: true,
        result: { group: await delayedRename.promise }
      }))
      .mockImplementationOnce(async () => {
        queueMicrotask(() => stage1Done.resolve())
        return {
          ok: true,
          result: { group: { ...remoteGroup, parentGroupId: 'parent-r', updatedAt: 5 } }
        }
      })
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectNewerStage2 = reject
          })
      )

    const olderRenamePromise = store
      .getState()
      .updateProjectGroup('remote-1', { name: 'Delayed Older Rename' })
    const newerMovePromise = store
      .getState()
      .updateProjectGroup('remote-1', { parentGroupId: 'parent-r', tabOrder: 0 })
    await stage1Done.promise
    await vi.waitFor(() => {
      expect(typeof rejectNewerStage2).toBe('function')
    })

    delayedRename.resolve({
      ...remoteGroup,
      name: 'Delayed Older Rename',
      parentGroupId: null,
      updatedAt: 4
    })
    expect(await olderRenamePromise).toBe(true)

    rejectNewerStage2(new Error('stage 2 rejected'))
    expect(await newerMovePromise).toBe(false)
    expect(store.getState().projectGroups.find((group) => group.id === 'remote-1')).toMatchObject({
      parentGroupId: 'parent-r'
    })

    // Stage 1 -> intermediate update B -> Stage 2 of A sharing equal updatedAt must keep A's Stage 2 state.
    store.setState({ projectGroups: [localGroup, remoteGroup, parentGroup] })
    const allowStage2Dispatch = Promise.withResolvers<void>()
    const stage1Ready = Promise.withResolvers<void>()
    let resolveB!: () => void
    runtimeEnvironmentCall
      .mockImplementationOnce(async () => {
        queueMicrotask(() => stage1Ready.resolve())
        await allowStage2Dispatch.promise
        return {
          ok: true,
          result: {
            group: { ...remoteGroup, parentGroupId: 'parent-r', tabOrder: 5, updatedAt: 10 }
          }
        }
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = () =>
              resolve({
                ok: true,
                result: {
                  group: {
                    ...remoteGroup,
                    name: 'Renamed Mid-Move',
                    parentGroupId: 'parent-r',
                    tabOrder: 5,
                    updatedAt: 10
                  }
                }
              })
          })
      )
      .mockResolvedValueOnce({
        ok: true,
        result: {
          group: {
            ...remoteGroup,
            name: 'Renamed Mid-Move',
            parentGroupId: 'parent-r',
            tabOrder: 0,
            updatedAt: 10
          }
        }
      })

    const stagedMoveA = store
      .getState()
      .updateProjectGroup('remote-1', { parentGroupId: 'parent-r', tabOrder: 0 })
    await stage1Ready.promise
    const intermediateRenameB = store
      .getState()
      .updateProjectGroup('remote-1', { name: 'Renamed Mid-Move' })
    await vi.waitFor(() => {
      expect(typeof resolveB).toBe('function')
    })
    resolveB()
    expect(await intermediateRenameB).toBe(true)
    allowStage2Dispatch.resolve()
    expect(await stagedMoveA).toBe(true)
    expect(store.getState().projectGroups.find((group) => group.id === 'remote-1')).toMatchObject({
      name: 'Renamed Mid-Move',
      parentGroupId: 'parent-r',
      tabOrder: 0
    })

    // Stage 1 of move A delayed behind completed move B to another parent halts A's Stage 2 tabOrder write.
    const parentQ: ProjectGroup = { ...parentGroup, id: 'parent-q', name: 'Parent Q' }
    store.setState({ projectGroups: [remoteGroup, parentGroup, parentQ] })
    const callsBeforeSuperseded = runtimeEnvironmentCall.mock.calls.length
    const allowDelayedStage1 = Promise.withResolvers<void>()
    const delayedStage1Started = Promise.withResolvers<void>()
    runtimeEnvironmentCall
      .mockImplementationOnce(async () => {
        queueMicrotask(() => delayedStage1Started.resolve())
        await allowDelayedStage1.promise
        return {
          ok: true,
          result: {
            group: { ...remoteGroup, parentGroupId: 'parent-r', tabOrder: 5, updatedAt: 10 }
          }
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          group: { ...remoteGroup, parentGroupId: 'parent-q', tabOrder: 5, updatedAt: 10 }
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          group: { ...remoteGroup, parentGroupId: 'parent-q', tabOrder: 9, updatedAt: 10 }
        }
      })

    const supersededMoveA = store
      .getState()
      .updateProjectGroup('remote-1', { parentGroupId: 'parent-r', tabOrder: 0 })
    await delayedStage1Started.promise
    const winningMoveB = store
      .getState()
      .updateProjectGroup('remote-1', { parentGroupId: 'parent-q', tabOrder: 9 })

    expect(await winningMoveB).toBe(true)
    allowDelayedStage1.resolve()
    expect(await supersededMoveA).toBe(false)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(callsBeforeSuperseded + 3)
    expect(store.getState().projectGroups.find((group) => group.id === 'remote-1')).toMatchObject({
      parentGroupId: 'parent-q',
      tabOrder: 9
    })
    consoleErrorSpy.mockRestore()
  })
})
