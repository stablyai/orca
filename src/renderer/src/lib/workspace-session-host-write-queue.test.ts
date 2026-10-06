import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RemoteWorkspaceTestimonyState } from './remote-workspace-host-testimony'
import {
  enqueueHostPartitionWrite,
  resetHostPartitionWriteStateForTest,
  type HostPartitionWriteOptions
} from './workspace-session-host-write-queue'

describe('workspace-session-host-write-queue', () => {
  it('serializes concurrent writes for the same host in FIFO order', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostId = 'ssh:target-1' as ExecutionHostId
    const order: number[] = []

    let resolveFirstWrite: (() => void) | undefined
    const firstWritePromise = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve
    })

    const write1 = enqueueHostPartitionWrite(hostId, async () => {
      await firstWritePromise
      order.push(1)
      return 'result-1'
    })

    const write2 = enqueueHostPartitionWrite(hostId, async () => {
      order.push(2)
      return 'result-2'
    })

    expect(order).toEqual([])
    resolveFirstWrite?.()

    const [res1, res2] = await Promise.all([write1, write2])
    expect(res1).toBe('result-1')
    expect(res2).toBe('result-2')
    expect(order).toEqual([1, 2])
  })

  it('allows independent writes for distinct hosts to run concurrently', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostA = 'ssh:target-a' as ExecutionHostId
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostB = 'ssh:target-b' as ExecutionHostId

    let hostAStarted = false
    let hostBStarted = false
    let resolveAll: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveAll = resolve
    })

    const writeA = enqueueHostPartitionWrite(hostA, async () => {
      hostAStarted = true
      await gate
      return 'done-a'
    })

    const writeB = enqueueHostPartitionWrite(hostB, async () => {
      hostBStarted = true
      await gate
      return 'done-b'
    })

    await vi.waitFor(() => {
      expect(hostAStarted).toBe(true)
      expect(hostBStarted).toBe(true)
    })

    resolveAll?.()
    const [resA, resB] = await Promise.all([writeA, writeB])
    expect(resA).toBe('done-a')
    expect(resB).toBe('done-b')
  })

  it('skips a queued write if a newer generation write has already superseded it', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostId = 'ssh:target-1' as ExecutionHostId

    const executionLog: string[] = []

    let resolveActive: (() => void) | undefined
    const activeBlocker = new Promise<void>((resolve) => {
      resolveActive = resolve
    })

    const activeWrite = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('active')
        await activeBlocker
        return 'active-res'
      },
      { generation: 1 }
    )

    const supersededWrite = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('superseded')
        return 'superseded-res'
      },
      { generation: 2 }
    )

    const latestWrite = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('latest')
        return 'latest-res'
      },
      { generation: 3 }
    )

    resolveActive?.()

    const [resActive, resSuperseded, resLatest] = await Promise.all([
      activeWrite,
      supersededWrite,
      latestWrite
    ])

    expect(resActive).toBe('active-res')
    expect(resSuperseded).toBeNull()
    expect(resLatest).toBe('latest-res')
    expect(executionLog).toEqual(['active', 'latest'])
  })

  it('skips a pre-testimony write if testimony arrives before the write begins', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostId = 'ssh:target-1' as ExecutionHostId

    let testimonyArrived = false
    let resolveActive: (() => void) | undefined
    const activeBlocker = new Promise<void>((resolve) => {
      resolveActive = resolve
    })

    const activeWrite = enqueueHostPartitionWrite(hostId, async () => {
      await activeBlocker
      return 'active-done'
    })

    const writeFn = vi.fn().mockResolvedValue('testimony-guarded-res')

    const guardedWrite = enqueueHostPartitionWrite(hostId, writeFn, {
      shouldSkip: () => testimonyArrived
    })

    testimonyArrived = true
    resolveActive?.()

    const [resActive, resGuarded] = await Promise.all([activeWrite, guardedWrite])
    expect(resActive).toBe('active-done')
    expect(resGuarded).toBeNull()
    expect(writeFn).not.toHaveBeenCalled()
  })

  it('does not discard a queued write with replaceable: false when a newer generation write is enqueued', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostId = 'ssh:target-1' as ExecutionHostId

    const executionLog: string[] = []

    let resolveActive: (() => void) | undefined
    const activeBlocker = new Promise<void>((resolve) => {
      resolveActive = resolve
    })

    const activeWrite = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('active')
        await activeBlocker
        return 'active-res'
      },
      { generation: 1 }
    )

    const nonReplaceableWrite = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('partial-patch')
        return 'partial-patch-res'
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Slice 2 test fixture exercising planned replaceable option
      { generation: 2, replaceable: false } as HostPartitionWriteOptions
    )

    const latestWrite = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('latest')
        return 'latest-res'
      },
      { generation: 3 }
    )

    resolveActive?.()

    const [resActive, resNonReplaceable, resLatest] = await Promise.all([
      activeWrite,
      nonReplaceableWrite,
      latestWrite
    ])

    expect(resActive).toBe('active-res')
    expect(resNonReplaceable).toBe('partial-patch-res')
    expect(resLatest).toBe('latest-res')
    expect(executionLog).toEqual(['active', 'partial-patch', 'latest'])
  })

  it('does not discard a queued replaceable persist when a subsequent non-replaceable patch is enqueued', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostId = 'ssh:target-1' as ExecutionHostId

    const executionLog: string[] = []

    let resolveActive: (() => void) | undefined
    const activeBlocker = new Promise<void>((resolve) => {
      resolveActive = resolve
    })

    const activeWrite = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('active')
        await activeBlocker
        return 'active-res'
      },
      { generation: 1 }
    )

    const replaceablePersist = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('replaceable-persist')
        return 'replaceable-persist-res'
      },
      { generation: 2, replaceable: true }
    )

    const subsequentPatch = enqueueHostPartitionWrite(
      hostId,
      async () => {
        executionLog.push('subsequent-patch')
        return 'subsequent-patch-res'
      },
      { replaceable: false }
    )

    resolveActive?.()

    const [resActive, resPersist, resPatch] = await Promise.all([
      activeWrite,
      replaceablePersist,
      subsequentPatch
    ])

    expect(resActive).toBe('active-res')
    expect(resPersist).toBe('replaceable-persist-res')
    expect(resPatch).toBe('subsequent-patch-res')
    expect(executionLog).toEqual(['active', 'replaceable-persist', 'subsequent-patch'])
  })

  it('discards a pre-testimony write when live testimony lands before dequeuing even with an immutable initial state', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostId = 'ssh:target-1' as ExecutionHostId

    const initialTestimonyState: RemoteWorkspaceTestimonyState = Object.freeze({
      remoteWorkspaceHydratedTargetIds: new Set<string>(),
      remoteWorkspaceSyncStatusByTargetId: {}
    })

    let liveState: RemoteWorkspaceTestimonyState = initialTestimonyState

    let resolveActive: (() => void) | undefined
    const activeBlocker = new Promise<void>((resolve) => {
      resolveActive = resolve
    })

    const activeWrite = enqueueHostPartitionWrite(hostId, async () => {
      await activeBlocker
      return 'active-done'
    })

    const writeFn = vi.fn().mockResolvedValue('testimony-guarded-res')

    const guardedWrite = enqueueHostPartitionWrite(hostId, initialTestimonyState, writeFn, {
      getLiveState: () => liveState
    })

    // Live testimony arrives before the active write finishes, updating liveState
    // while initialTestimonyState remains frozen and untouched.
    liveState = {
      remoteWorkspaceHydratedTargetIds: new Set(['target-1']),
      remoteWorkspaceSyncStatusByTargetId: {
        'target-1': { phase: 'idle' }
      }
    }

    resolveActive?.()

    const [resActive, resGuarded] = await Promise.all([activeWrite, guardedWrite])
    expect(resActive).toBe('active-done')
    expect(resGuarded).toBeNull()
    expect(writeFn).not.toHaveBeenCalled()
  })

  it('does not discard a pre-testimony write when carriesParkedShadowRows is false even if testimony arrives before dequeuing', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostId = 'ssh:target-1' as ExecutionHostId

    const initialTestimonyState: RemoteWorkspaceTestimonyState = Object.freeze({
      remoteWorkspaceHydratedTargetIds: new Set<string>(),
      remoteWorkspaceSyncStatusByTargetId: {}
    })

    let liveState: RemoteWorkspaceTestimonyState = initialTestimonyState

    let resolveActive: (() => void) | undefined
    const activeBlocker = new Promise<void>((resolve) => {
      resolveActive = resolve
    })

    const activeWrite = enqueueHostPartitionWrite(hostId, async () => {
      await activeBlocker
      return 'active-done'
    })

    const writeFn = vi.fn().mockResolvedValue('fresh-edit-res')

    const patchWrite = enqueueHostPartitionWrite(hostId, initialTestimonyState, writeFn, {
      getLiveState: () => liveState,
      carriesParkedShadowRows: false
    })

    // Live testimony arrives before the active write finishes
    liveState = {
      remoteWorkspaceHydratedTargetIds: new Set(['target-1']),
      remoteWorkspaceSyncStatusByTargetId: {
        'target-1': { phase: 'idle' }
      }
    }

    resolveActive?.()

    const [resActive, resPatch] = await Promise.all([activeWrite, patchWrite])
    expect(resActive).toBe('active-done')
    expect(resPatch).toBe('fresh-edit-res')
    expect(writeFn).toHaveBeenCalledTimes(1)
  })

  it('resetHostPartitionWriteStateForTest clears write chains and generation counters', async () => {
    resetHostPartitionWriteStateForTest()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture mock
    const hostId = 'ssh:target-1' as ExecutionHostId

    const write1 = await enqueueHostPartitionWrite(hostId, async () => 'first', { generation: 10 })
    expect(write1).toBe('first')

    resetHostPartitionWriteStateForTest()

    // With a lower generation number after reset, it should not be treated as superseded
    const writeAfterReset = await enqueueHostPartitionWrite(hostId, async () => 'after-reset', {
      generation: 1
    })
    expect(writeAfterReset).toBe('after-reset')
  })
})
