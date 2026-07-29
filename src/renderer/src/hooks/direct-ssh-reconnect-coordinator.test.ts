import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostQualifiedDetectedWorktreeResult,
  ProviderRequestId
} from '../../../shared/detected-worktree-provider-contract'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import {
  createDirectSshWorktreeRefreshScheduler,
  type DirectSshWorktreeRefreshKey,
  type DirectSshWorktreeRefreshLease,
  type DirectSshWorktreeRefreshOutcome,
  type DirectSshWorktreeRefreshScheduler,
  type WaiterLeaseId
} from './direct-ssh-worktree-refresh-scheduler'
import {
  admitDirectSshSnapshotApplyToken,
  buildDirectSshSnapshotApplyToken,
  createDirectSshReconnectCoordinator,
  type DirectSshLineageOutcome,
  type DirectSshPreparationInput,
  type DirectSshReconnectCoordinatorDeps
} from './direct-ssh-reconnect-coordinator'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function epoch(value: string): SshProviderEpoch {
  return value as SshProviderEpoch
}

function authority(targetId: string, epochId = `epoch-${targetId}`): DirectSshAuthority {
  return {
    targetId,
    providerEpoch: epoch(epochId),
    connectionGeneration: 1
  }
}

function preparationInput(
  owner: DirectSshAuthority,
  repoIds: readonly string[] = ['repo'],
  overrides: Partial<DirectSshPreparationInput> = {}
): DirectSshPreparationInput {
  return {
    ...owner,
    catalogRevision: 1,
    repoRefs: repoIds.map((repoId) => ({
      repoId,
      executionHostId: `ssh:${owner.targetId}`
    })),
    authorityRequirement: 'required',
    reason: 'workspace-snapshot',
    ...overrides
  }
}

type FakeLease = {
  key: DirectSshWorktreeRefreshKey
  deferred: Deferred<DirectSshWorktreeRefreshOutcome>
  lease: DirectSshWorktreeRefreshLease
}

function createFakeScheduler(): {
  scheduler: DirectSshWorktreeRefreshScheduler
  leases: FakeLease[]
  complete: (index: number, status?: DirectSshWorktreeRefreshOutcome['status']) => void
} {
  const leases: FakeLease[] = []
  const request = vi.fn((key: DirectSshWorktreeRefreshKey) => {
    const leaseDeferred = deferred<DirectSshWorktreeRefreshOutcome>()
    let released = false
    const lease: DirectSshWorktreeRefreshLease = {
      waiterLeaseId: `lease-${leases.length + 1}` as WaiterLeaseId,
      result: leaseDeferred.promise,
      release: vi.fn(() => {
        if (!released) {
          released = true
          leaseDeferred.resolve({ status: 'canceled' })
        }
      })
    }
    leases.push({ key, deferred: leaseDeferred, lease })
    return lease
  })
  const scheduler: DirectSshWorktreeRefreshScheduler = {
    request,
    invalidateAuthority: vi.fn(),
    invalidateTarget: vi.fn(),
    disposeProvider: vi.fn(),
    getSnapshot: vi.fn(() => ({
      locallyUnsettled: 0,
      queued: 0,
      retrying: 0,
      logicalTasks: leases.length,
      waiters: leases.length,
      cancelDebtByAuthority: new Map()
    })),
    stop: vi.fn()
  }
  return {
    scheduler,
    leases,
    complete: (index, status = 'complete') => leases[index].deferred.resolve({ status })
  }
}

function createCoordinatorHarness(fakeScheduler = createFakeScheduler()) {
  const current = new Map<string, DirectSshAuthority>()
  const events: string[] = []
  const capturePreparationInput = vi.fn(
    async (owner: DirectSshAuthority, reason: DirectSshPreparationInput['reason']) => {
      events.push(`capture:${owner.targetId}`)
      return preparationInput(owner, ['repo'], { reason })
    }
  )
  const deps: DirectSshReconnectCoordinatorDeps = {
    scheduler: fakeScheduler.scheduler,
    isCurrentConnectedAuthority: (owner) => {
      const active = current.get(owner.targetId)
      return (
        active?.providerEpoch === owner.providerEpoch &&
        active.connectionGeneration === owner.connectionGeneration
      )
    },
    capturePreparationInput,
    readHostScopedLineage: vi.fn(async (): Promise<DirectSshLineageOutcome> => 'complete'),
    invalidateStaleTerminalBindings: vi.fn((owner) => {
      events.push(`invalidate:${owner.targetId}`)
      return 1
    }),
    retryTargetPanes: vi.fn((owner) => {
      events.push(`retry:${owner.targetId}`)
      return 2
    }),
    finalizeHydratedTerminalPanes: vi.fn(() => 1),
    correctUnboundTerminalPanes: vi.fn(() => 1),
    syncRemoteWorkspaceAfterConnect: vi.fn(),
    onTelemetry: vi.fn()
  }
  const coordinator = createDirectSshReconnectCoordinator(deps)
  return { coordinator, deps, current, events, ...fakeScheduler }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createDirectSshReconnectCoordinator', () => {
  it('runs terminal invalidation and retry synchronously before preparation awaits', () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)

    void harness.coordinator.requestReconnect(owner)

    expect(harness.events).toEqual(['invalidate:target-a', 'retry:target-a', 'capture:target-a'])
    expect(harness.leases).toHaveLength(0)
  })

  it('prepares the first observed authority immediately', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)

    const pending = harness.coordinator.requestReconnect(owner)
    await flush()

    expect(harness.deps.capturePreparationInput).toHaveBeenCalledWith(owner, 'reconnect')
    expect(harness.leases).toHaveLength(1)
    harness.complete(0)
    await expect(pending).resolves.toMatchObject({ status: 'complete', stabilizing: false })
  })

  it('keeps target B independent while target A preparation is blocked', async () => {
    const harness = createCoordinatorHarness()
    const targetA = authority('target-a')
    const targetB = authority('target-b')
    harness.current.set(targetA.targetId, targetA)
    harness.current.set(targetB.targetId, targetB)

    const pendingA = harness.coordinator.requestReconnect(targetA)
    await flush()
    const pendingB = harness.coordinator.requestReconnect(targetB)
    await flush()
    expect(harness.leases).toHaveLength(2)

    harness.complete(1)
    await expect(pendingB).resolves.toMatchObject({ status: 'complete' })
    expect(harness.deps.syncRemoteWorkspaceAfterConnect).toHaveBeenCalledTimes(1)

    let targetASettled = false
    void pendingA.then(() => {
      targetASettled = true
    })
    await flush()
    expect(targetASettled).toBe(false)
    harness.coordinator.stop()
  })

  it('treats exact-equal authority replacement as a true timing no-op', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')

    harness.coordinator.replaceAuthority(owner)
    vi.setSystemTime(4_000)
    harness.coordinator.replaceAuthority({ ...owner })

    expect(harness.scheduler.disposeProvider).not.toHaveBeenCalled()
    expect(harness.scheduler.invalidateTarget).not.toHaveBeenCalled()

    vi.setSystemTime(5_001)
    const next = authority('target-a', 'next')
    harness.current.set(next.targetId, next)
    const pending = harness.coordinator.requestReconnect(next)
    await flush()

    expect(harness.deps.capturePreparationInput).toHaveBeenCalledWith(next, 'reconnect')
    harness.complete(0)
    await expect(pending).resolves.toMatchObject({ status: 'complete', stabilizing: false })
  })

  it('cancels obsolete work on changed authority without ordering epochs', async () => {
    const harness = createCoordinatorHarness()
    const oldOwner = authority('target-a', 'z-old')
    const newOwner = authority('target-a', 'a-new')
    harness.current.set(oldOwner.targetId, oldOwner)
    harness.coordinator.replaceAuthority(oldOwner)
    const pending = harness.coordinator.prepareOnly(preparationInput(oldOwner))
    await flush()

    harness.current.set(newOwner.targetId, newOwner)
    harness.coordinator.replaceAuthority(newOwner)

    await expect(pending).resolves.toMatchObject({ status: 'stale', token: null })
    expect(harness.leases[0].lease.release).toHaveBeenCalledWith('invalidated')
    expect(harness.scheduler.disposeProvider).toHaveBeenCalledWith(oldOwner)
  })

  it('settles invalidation locally while a late lineage read remains pending', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    const lineage = deferred<'complete'>()
    vi.mocked(harness.deps.readHostScopedLineage).mockReturnValue(lineage.promise)
    harness.current.set(owner.targetId, owner)
    harness.coordinator.replaceAuthority(owner)
    const pending = harness.coordinator.prepareOnly(preparationInput(owner))
    harness.complete(0)
    await flush()
    expect(harness.deps.readHostScopedLineage).toHaveBeenCalledOnce()

    harness.coordinator.invalidate(owner.targetId)
    await expect(pending).resolves.toMatchObject({ status: 'stale', token: null })

    lineage.resolve('complete')
    await flush()
    expect(harness.deps.syncRemoteWorkspaceAfterConnect).not.toHaveBeenCalled()
  })

  it('joins exact overlapping preparation and reruns after completion', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)
    harness.coordinator.replaceAuthority(owner)
    const input = preparationInput(owner)

    const first = harness.coordinator.prepareOnly(input)
    const joined = harness.coordinator.prepareOnly({
      ...input,
      repoRefs: input.repoRefs.toReversed()
    })
    expect(joined).toBe(first)
    expect(harness.leases).toHaveLength(1)

    harness.complete(0)
    await expect(first).resolves.toMatchObject({ status: 'complete' })
    const later = harness.coordinator.prepareOnly(input)
    expect(later).not.toBe(first)
    expect(harness.leases).toHaveLength(2)
    harness.coordinator.stop()
  })

  it('keeps prepare-only isolated from terminal retry and reconnect sync', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)
    harness.coordinator.replaceAuthority(owner)
    const pending = harness.coordinator.prepareOnly(preparationInput(owner))
    harness.complete(0, 'non-authoritative')

    await expect(pending).resolves.toMatchObject({
      status: 'degraded',
      token: { outcome: 'degraded' }
    })
    expect(harness.deps.invalidateStaleTerminalBindings).not.toHaveBeenCalled()
    expect(harness.deps.retryTargetPanes).not.toHaveBeenCalled()
    expect(harness.deps.correctUnboundTerminalPanes).not.toHaveBeenCalled()
    expect(harness.deps.syncRemoteWorkspaceAfterConnect).not.toHaveBeenCalled()
  })

  it('rejects repo refs for another SSH host before scheduler admission', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)
    harness.coordinator.replaceAuthority(owner)

    await expect(
      harness.coordinator.prepareOnly(
        preparationInput(owner, ['repo'], {
          repoRefs: [{ repoId: 'repo', executionHostId: 'ssh:target-b' }]
        })
      )
    ).resolves.toMatchObject({ status: 'stale', token: null })

    expect(harness.leases).toHaveLength(0)
    expect(harness.deps.readHostScopedLineage).not.toHaveBeenCalled()
  })

  it('holds lineage and token creation through the scheduler timeout retry barrier', async () => {
    const attempts: {
      id: ProviderRequestId
      deferred: Deferred<HostQualifiedDetectedWorktreeResult>
      key: DirectSshWorktreeRefreshKey
    }[] = []
    const scheduler = createDirectSshWorktreeRefreshScheduler({
      startAttempt: (attemptKey) => {
        const result = deferred<HostQualifiedDetectedWorktreeResult>()
        const id = `provider-${attempts.length + 1}` as ProviderRequestId
        attempts.push({ id, deferred: result, key: attemptKey })
        return { providerRequestId: id, result: result.promise, cancel: vi.fn() }
      }
    })
    const harness = createCoordinatorHarness({
      scheduler,
      leases: [],
      complete: () => {}
    })
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)
    harness.coordinator.replaceAuthority(owner)
    const pending = harness.coordinator.prepareOnly(preparationInput(owner))

    attempts[0].deferred.resolve({
      status: 'timed-out',
      providerRequestId: attempts[0].id,
      executionHostId: attempts[0].key.executionHostId
    })
    await flush()
    expect(attempts).toHaveLength(2)
    expect(harness.deps.readHostScopedLineage).not.toHaveBeenCalled()

    attempts[1].deferred.resolve({
      status: 'complete',
      providerRequestId: attempts[1].id,
      repoId: 'repo',
      authority: {
        kind: 'direct-ssh',
        executionHostId: attempts[1].key.executionHostId,
        ...owner
      },
      result: { repoId: 'repo', authoritative: true, source: 'git', worktrees: [] }
    })
    await expect(pending).resolves.toMatchObject({ status: 'complete', token: {} })
    expect(harness.deps.readHostScopedLineage).toHaveBeenCalledOnce()
  })

  it('starts lineage only after every repo is terminal and returns a fenced token', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)
    harness.coordinator.replaceAuthority(owner)
    const pending = harness.coordinator.prepareOnly(
      preparationInput(owner, ['repo-b', 'repo-a'], {
        catalogRevision: 7,
        snapshotRevision: 11
      })
    )
    expect(harness.leases.map((lease) => lease.key.repoId)).toEqual(['repo-a', 'repo-b'])

    harness.complete(0)
    await flush()
    expect(harness.deps.readHostScopedLineage).not.toHaveBeenCalled()
    harness.complete(1)

    await expect(pending).resolves.toMatchObject({
      status: 'complete',
      token: {
        authority: owner,
        catalogRevision: 7,
        snapshotRevision: 11,
        outcome: 'complete'
      }
    })
    expect(harness.deps.readHostScopedLineage).toHaveBeenCalledOnce()
  })

  it('requires exact snapshot revision and authority admission', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)
    harness.coordinator.replaceAuthority(owner)
    const pending = harness.coordinator.prepareOnly(
      preparationInput(owner, [], { snapshotRevision: 5 })
    )
    const prepared = await pending
    const token = prepared.token!

    expect(buildDirectSshSnapshotApplyToken(token, 6)).toBeNull()
    const exact = buildDirectSshSnapshotApplyToken(token, 5)!
    expect(admitDirectSshSnapshotApplyToken(exact, owner, 5)).toBe(true)
    expect(admitDirectSshSnapshotApplyToken(exact, owner, 6)).toBe(false)
    expect(admitDirectSshSnapshotApplyToken(exact, authority('target-a', 'other'), 5)).toBe(false)
  })

  it('damps rapid rotations to the latest authority while terminal checks stay immediate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const harness = createCoordinatorHarness()
    const initial = authority('target-a', 'initial')
    const middle = authority('target-a', 'middle')
    const flapping = authority('target-a', 'flapping')
    const latest = authority('target-a', 'latest')
    harness.current.set(initial.targetId, initial)
    harness.coordinator.replaceAuthority(initial)

    vi.setSystemTime(5_001)
    harness.current.set(middle.targetId, middle)
    const stableReplacement = harness.coordinator.requestReconnect(middle)
    await flush()
    harness.complete(0)
    await expect(stableReplacement).resolves.toMatchObject({
      status: 'complete',
      stabilizing: false
    })

    vi.setSystemTime(6_000)
    harness.current.set(flapping.targetId, flapping)
    await expect(harness.coordinator.requestReconnect(flapping)).resolves.toMatchObject({
      status: 'stabilizing'
    })
    vi.setSystemTime(7_000)
    harness.current.set(latest.targetId, latest)
    await expect(harness.coordinator.requestReconnect(latest)).resolves.toMatchObject({
      status: 'stabilizing'
    })

    expect(harness.deps.retryTargetPanes).toHaveBeenCalledTimes(3)
    expect(harness.deps.capturePreparationInput).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(harness.deps.capturePreparationInput).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.deps.capturePreparationInput).toHaveBeenCalledTimes(2)
    expect(harness.deps.capturePreparationInput).toHaveBeenCalledWith(latest, 'reconnect')
    expect(harness.deps.capturePreparationInput).not.toHaveBeenCalledWith(flapping, 'reconnect')
    harness.complete(1)
  })

  it('corrects only current authority and cleans pending work and timers on stop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const harness = createCoordinatorHarness()
    const initial = authority('target-a', 'initial')
    const latest = authority('target-a', 'latest')
    harness.current.set(initial.targetId, initial)
    harness.coordinator.replaceAuthority(initial)
    harness.current.set(latest.targetId, latest)
    void harness.coordinator.requestReconnect(latest)

    expect(harness.coordinator.correctUnboundTerminals(latest, 'wake-refresh')).toBe(1)
    expect(harness.coordinator.finalizeHydratedTerminals(initial)).toBe(0)
    harness.coordinator.stop()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(harness.deps.capturePreparationInput).not.toHaveBeenCalled()
    expect(harness.scheduler.stop).toHaveBeenCalledOnce()
    expect(harness.coordinator.correctUnboundTerminals(latest, 'wake-refresh')).toBe(0)
  })

  it('emits one aggregate for joined work with scheduler and scope metrics', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)
    harness.coordinator.replaceAuthority(owner)
    const input = preparationInput(owner, ['repo'], {
      telemetry: {
        catalogOutcome: 'degraded',
        catalogDurationMs: 12,
        gitWorktreeCount: 3,
        folderWorkspaceCount: 2,
        ambiguousOwnerCount: 1,
        contradictoryOwnerCount: 1
      }
    })

    const first = harness.coordinator.prepareOnly(input)
    const joined = harness.coordinator.prepareOnly(input)
    harness.leases[0].deferred.resolve({
      status: 'complete',
      metrics: {
        queueWaitDurationsMs: [8],
        providerExecutionDurationsMs: [13],
        timeoutRetryCount: 1,
        locallySettledWaiterCount: 1,
        cancelDebtCount: 1,
        replacementAdmissionDelayedCount: 1,
        overlappingJoinCount: 2,
        peakLocallyUnsettled: 4,
        estimatedLateWorkAllowanceCount: 1
      }
    })
    await Promise.all([first, joined])

    expect(harness.deps.onTelemetry).toHaveBeenCalledOnce()
    expect(harness.deps.onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'prepare-only',
        catalogOutcome: 'degraded',
        catalogDurationMs: 12,
        gitWorktreeCount: 3,
        folderWorkspaceCount: 2,
        queueWaitDurationsMs: [8],
        providerExecutionDurationsMs: [13],
        timeoutRetryCount: 1,
        cancelDebtCount: 1,
        replacementAdmissionDelayedCount: 1,
        overlappingJoinCount: 3,
        peakLocallyUnsettled: 4
      })
    )
  })

  it('does not let a telemetry callback failure affect recovery', async () => {
    const harness = createCoordinatorHarness()
    const owner = authority('target-a')
    harness.current.set(owner.targetId, owner)
    vi.mocked(harness.deps.onTelemetry!).mockImplementation(() => {
      throw new Error('telemetry unavailable')
    })

    const pending = harness.coordinator.requestReconnect(owner)
    await flush()
    harness.complete(0)

    await expect(pending).resolves.toMatchObject({ status: 'complete' })
  })
})
