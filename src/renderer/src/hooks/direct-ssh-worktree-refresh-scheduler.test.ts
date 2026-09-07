import { describe, expect, it, vi } from 'vitest'
import type {
  HostQualifiedDetectedWorktreeResult,
  ProviderRequestId
} from '../../../shared/detected-worktree-provider-contract'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import {
  createDirectSshWorktreeRefreshScheduler,
  DIRECT_SSH_WORKTREE_SCAN_CONCURRENCY,
  type DirectSshWorktreeRefreshAttempt,
  type DirectSshWorktreeRefreshKey,
  type DirectSshWorktreeRefreshReleaseReason
} from './direct-ssh-worktree-refresh-scheduler'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

type ControlledAttempt = DirectSshWorktreeRefreshAttempt & {
  key: DirectSshWorktreeRefreshKey
  deferred: Deferred<HostQualifiedDetectedWorktreeResult>
  cancel: ReturnType<typeof vi.fn<DirectSshWorktreeRefreshAttempt['cancel']>>
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

function requestId(value: string): ProviderRequestId {
  return value as ProviderRequestId
}

function key(
  targetId: string,
  repoId: string,
  overrides: Partial<DirectSshWorktreeRefreshKey> = {}
): DirectSshWorktreeRefreshKey {
  return {
    targetId,
    repoId,
    executionHostId: `ssh:${targetId}`,
    providerEpoch: epoch(`epoch-${targetId}`),
    connectionGeneration: 1,
    catalogRevision: 1,
    authorityRequirement: 'required',
    ...overrides
  }
}

function terminalResult(
  attempt: ControlledAttempt,
  status: 'timed-out' | 'canceled' | 'stale' | 'rejected'
): HostQualifiedDetectedWorktreeResult {
  return {
    status,
    providerRequestId: attempt.providerRequestId,
    executionHostId: attempt.key.executionHostId
  }
}

function completeResult(
  attempt: ControlledAttempt,
  status: 'complete' | 'non-authoritative' = 'complete'
): HostQualifiedDetectedWorktreeResult {
  return {
    status,
    providerRequestId: attempt.providerRequestId,
    repoId: attempt.key.repoId,
    authority: {
      kind: 'direct-ssh',
      executionHostId: attempt.key.executionHostId,
      targetId: attempt.key.targetId,
      providerEpoch: attempt.key.providerEpoch,
      connectionGeneration: attempt.key.connectionGeneration
    },
    result: {
      repoId: attempt.key.repoId,
      authoritative: status === 'complete',
      source: status === 'complete' ? 'git' : 'metadata-fallback',
      worktrees: []
    }
  }
}

function createHarness(cancelOutcome?: 'cancel-failed', now?: () => number) {
  const attempts: ControlledAttempt[] = []
  const onUnexpectedError = vi.fn()
  const startAttempt = vi.fn((attemptKey: DirectSshWorktreeRefreshKey) => {
    const providerDeferred = deferred<HostQualifiedDetectedWorktreeResult>()
    const waiterDeferred = deferred<HostQualifiedDetectedWorktreeResult>()
    const providerRequestId = requestId(`provider-${attempts.length + 1}`)
    const attempt: ControlledAttempt = {
      key: attemptKey,
      providerRequestId,
      result: waiterDeferred.promise,
      deferred: providerDeferred,
      cancel: vi.fn((_reason: DirectSshWorktreeRefreshReleaseReason) => {
        waiterDeferred.resolve({
          providerRequestId,
          executionHostId: attemptKey.executionHostId,
          status: 'canceled'
        })
        return cancelOutcome
      })
    }
    void providerDeferred.promise.then(waiterDeferred.resolve, waiterDeferred.reject)
    attempts.push(attempt)
    return attempt
  })
  const scheduler = createDirectSshWorktreeRefreshScheduler({
    startAttempt,
    onUnexpectedError,
    now
  })
  return { scheduler, attempts, startAttempt, onUnexpectedError }
}

async function flushAttempt(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('createDirectSshWorktreeRefreshScheduler', () => {
  it('admits an idle singleton immediately and cleans it up on completion', async () => {
    const { scheduler, attempts, startAttempt } = createHarness()
    const lease = scheduler.request(key('target-a', 'repo-a'))

    expect(startAttempt).toHaveBeenCalledTimes(1)
    expect(scheduler.getSnapshot().locallyUnsettled).toBe(1)

    attempts[0].deferred.resolve(completeResult(attempts[0]))
    await expect(lease.result).resolves.toMatchObject({ status: 'complete' })
    await flushAttempt()
    expect(scheduler.getSnapshot()).toMatchObject({
      locallyUnsettled: 0,
      logicalTasks: 0,
      waiters: 0
    })
  })

  it('never admits more than five locally unsettled attempts', async () => {
    const { scheduler, attempts } = createHarness()
    const leases = Array.from({ length: 6 }, (_, index) =>
      scheduler.request(key('target-a', `repo-${index}`))
    )

    expect(attempts).toHaveLength(DIRECT_SSH_WORKTREE_SCAN_CONCURRENCY)
    expect(scheduler.getSnapshot().queued).toBe(1)

    attempts[0].deferred.resolve(completeResult(attempts[0]))
    await leases[0].result
    await flushAttempt()
    expect(attempts).toHaveLength(6)
    expect(scheduler.getSnapshot().locallyUnsettled).toBe(5)

    scheduler.stop()
  })

  it('round-robins target lanes after at most one earlier lane admission', async () => {
    const { scheduler, attempts } = createHarness()
    const leases = Array.from({ length: 7 }, (_, index) =>
      scheduler.request(key('target-a', `repo-a-${index}`))
    )
    const targetB = scheduler.request(key('target-b', 'repo-b'))

    attempts[0].deferred.resolve(completeResult(attempts[0]))
    await leases[0].result
    await flushAttempt()
    expect(attempts[5].key.targetId).toBe('target-a')

    attempts[1].deferred.resolve(completeResult(attempts[1]))
    await leases[1].result
    await flushAttempt()
    expect(attempts[6].key.targetId).toBe('target-b')

    scheduler.stop()
    await expect(targetB.result).resolves.toMatchObject({ status: 'canceled' })
  })

  it('joins only exact keys and separates authority, revision, and requirement', () => {
    const { scheduler, attempts } = createHarness()
    const base = key('target-a', 'repo')
    const first = scheduler.request(base)
    const joined = scheduler.request({ ...base })
    scheduler.request({ ...base, providerEpoch: epoch('epoch-next') })
    scheduler.request({ ...base, connectionGeneration: 2 })
    scheduler.request({ ...base, catalogRevision: 2 })
    scheduler.request({ ...base, authorityRequirement: 'allow-metadata-fallback' })

    expect(first.waiterLeaseId).not.toBe(joined.waiterLeaseId)
    expect(attempts).toHaveLength(5)
    expect(scheduler.getSnapshot()).toMatchObject({ logicalTasks: 5, waiters: 6 })
    scheduler.stop()
  })

  it('keeps the logical barrier pending through one timeout and uses a fresh request ID', async () => {
    const { scheduler, attempts } = createHarness()
    const lease = scheduler.request(key('target-a', 'repo'))
    let settled = false
    void lease.result.then(() => {
      settled = true
    })

    attempts[0].deferred.resolve(terminalResult(attempts[0], 'timed-out'))
    await flushAttempt()

    expect(settled).toBe(false)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].providerRequestId).not.toBe(attempts[0].providerRequestId)

    attempts[1].deferred.resolve(completeResult(attempts[1]))
    await expect(lease.result).resolves.toMatchObject({
      status: 'complete',
      providerRequestId: attempts[1].providerRequestId
    })
  })

  it('requeues a timed-out retry at its target lane tail', async () => {
    const { scheduler, attempts } = createHarness()
    const retrying = scheduler.request(key('target-a', 'retrying'))
    const blockers = Array.from({ length: 4 }, (_, index) =>
      scheduler.request(key('target-a', `blocker-${index}`))
    )
    const targetB = scheduler.request(key('target-b', 'target-b'))

    attempts[0].deferred.resolve(terminalResult(attempts[0], 'timed-out'))
    await flushAttempt()
    expect(attempts[5].key.targetId).toBe('target-b')

    attempts[1].deferred.resolve(completeResult(attempts[1]))
    await blockers[0].result
    await flushAttempt()
    expect(attempts[6].key.repoId).toBe('retrying')

    attempts[6].deferred.resolve(completeResult(attempts[6]))
    await expect(retrying.result).resolves.toMatchObject({ status: 'complete' })
    scheduler.stop()
    await expect(targetB.result).resolves.toMatchObject({ status: 'canceled' })
  })

  it('makes a second timeout terminal', async () => {
    const { scheduler, attempts } = createHarness()
    const lease = scheduler.request(key('target-a', 'repo'))

    attempts[0].deferred.resolve(terminalResult(attempts[0], 'timed-out'))
    await flushAttempt()
    attempts[1].deferred.resolve(terminalResult(attempts[1], 'timed-out'))

    await expect(lease.result).resolves.toMatchObject({
      status: 'timed-out',
      providerRequestId: attempts[1].providerRequestId
    })
  })

  it('invalidates queued and current work without reporting cancellation errors', async () => {
    const { scheduler, attempts, onUnexpectedError } = createHarness()
    const leases = Array.from({ length: 6 }, (_, index) =>
      scheduler.request(key('target-a', `repo-${index}`))
    )

    scheduler.invalidateTarget('target-a')
    await expect(Promise.all(leases.map((lease) => lease.result))).resolves.toEqual(
      Array.from({ length: 6 }, () => expect.objectContaining({ status: 'stale' }))
    )
    expect(attempts.map((attempt) => attempt.cancel.mock.calls.length)).toEqual([1, 1, 1, 1, 1])
    expect(scheduler.getSnapshot()).toMatchObject({ logicalTasks: 0, waiters: 0 })

    for (const attempt of attempts) {
      attempt.deferred.reject(new Error('expected provider cancellation'))
    }
    await flushAttempt()
    expect(onUnexpectedError).not.toHaveBeenCalled()
    expect(scheduler.getSnapshot().locallyUnsettled).toBe(0)
  })

  it('bounds five failed cancellations to two replacements while old calls remain pending', async () => {
    const { scheduler, attempts } = createHarness('cancel-failed')
    const authority: DirectSshAuthority = {
      targetId: 'target-a',
      providerEpoch: epoch('epoch-target-a'),
      connectionGeneration: 1
    }
    const initial = Array.from({ length: 5 }, (_, index) =>
      scheduler.request(key('target-a', `old-${index}`))
    )
    scheduler.invalidateAuthority(authority)
    await Promise.all(initial.map((lease) => lease.result))
    await flushAttempt()
    expect(scheduler.getSnapshot()).toMatchObject({
      locallyUnsettled: 0,
      queued: 0,
      logicalTasks: 0
    })

    const replacements = Array.from({ length: 3 }, (_, index) =>
      scheduler.request(key('target-a', `replacement-${index}`))
    )
    expect(attempts).toHaveLength(7)
    expect(scheduler.getSnapshot().locallyUnsettled).toBe(2)
    await expect(replacements[2].result).resolves.toMatchObject({
      status: 'cancel-budget-exhausted'
    })

    attempts[5].deferred.resolve(completeResult(attempts[5]))
    attempts[6].deferred.resolve(completeResult(attempts[6]))
    await expect(
      Promise.all(replacements.slice(0, 2).map((lease) => lease.result))
    ).resolves.toEqual(
      Array.from({ length: 2 }, () => expect.objectContaining({ status: 'complete' }))
    )
    await flushAttempt()
    expect(scheduler.getSnapshot().locallyUnsettled).toBe(0)

    scheduler.disposeProvider(authority)
    for (const attempt of attempts.slice(0, 5)) {
      attempt.deferred.reject(new Error('late canceled provider'))
    }
    await flushAttempt()
    expect([...scheduler.getSnapshot().cancelDebtByAuthority.values()]).toEqual([])

    const afterDisposal = scheduler.request(key('target-a', 'after-disposal'))
    expect(attempts).toHaveLength(8)
    attempts[7].deferred.resolve(completeResult(attempts[7]))
    await expect(afterDisposal.result).resolves.toMatchObject({ status: 'complete' })
  })

  it('settles one released waiter without canceling a joined provider', async () => {
    const { scheduler, attempts } = createHarness()
    const refreshKey = key('target-a', 'repo')
    const released = scheduler.request(refreshKey)
    const retained = scheduler.request(refreshKey)

    released.release('superseded')
    await expect(released.result).resolves.toMatchObject({ status: 'canceled' })
    expect(attempts[0].cancel).not.toHaveBeenCalled()
    expect(scheduler.getSnapshot().waiters).toBe(1)

    attempts[0].deferred.resolve(completeResult(attempts[0]))
    await expect(retained.result).resolves.toMatchObject({ status: 'complete' })
    released.release('stopped')
    await flushAttempt()
    expect(scheduler.getSnapshot()).toMatchObject({ logicalTasks: 0, waiters: 0 })
  })

  it('does not charge cancel debt when a shared provider invocation stays active', async () => {
    const { scheduler, attempts } = createHarness()
    const lease = scheduler.request(key('target-a', 'repo'))
    attempts[0].cancel.mockReturnValue(false)

    lease.release('superseded')

    await expect(lease.result).resolves.toMatchObject({ status: 'canceled' })
    expect(attempts[0].cancel).toHaveBeenCalledOnce()
    expect([...scheduler.getSnapshot().cancelDebtByAuthority.values()]).toEqual([])

    attempts[0].deferred.resolve(completeResult(attempts[0]))
    await flushAttempt()
  })

  it('stops current and queued waiters and rejects later requests without starting', async () => {
    const { scheduler, attempts, startAttempt } = createHarness()
    const current = scheduler.request(key('target-a', 'current'))
    scheduler.stop()

    await expect(current.result).resolves.toMatchObject({ status: 'canceled' })
    expect(attempts[0].cancel).toHaveBeenCalledOnce()

    const afterStop = scheduler.request(key('target-a', 'after-stop'))
    await expect(afterStop.result).resolves.toMatchObject({ status: 'canceled' })
    expect(startAttempt).toHaveBeenCalledOnce()
    expect(scheduler.getSnapshot()).toMatchObject({ logicalTasks: 0, waiters: 0 })

    attempts[0].deferred.reject(new Error('stopped'))
    await flushAttempt()
  })

  it('surfaces non-authoritative and rejected terminal outcomes', async () => {
    const { scheduler, attempts } = createHarness()
    const metadata = scheduler.request(key('target-a', 'metadata'))
    const rejected = scheduler.request(key('target-a', 'rejected'))

    attempts[0].deferred.resolve(completeResult(attempts[0], 'non-authoritative'))
    attempts[1].deferred.resolve(terminalResult(attempts[1], 'rejected'))

    await expect(metadata.result).resolves.toMatchObject({ status: 'non-authoritative' })
    await expect(rejected.result).resolves.toMatchObject({ status: 'rejected' })
  })

  it('reports queue wait, provider execution, retry, joins, and scoped peak metrics', async () => {
    let now = 0
    const { scheduler, attempts } = createHarness(undefined, () => now)
    const leases = Array.from({ length: 6 }, (_, index) =>
      scheduler.request(key('target-a', `repo-${index}`))
    )
    scheduler.request(key('target-a', 'repo-5'))

    now = 25
    attempts[0].deferred.resolve(completeResult(attempts[0]))
    await leases[0].result
    await flushAttempt()
    expect(attempts).toHaveLength(6)

    now = 100
    attempts[5].deferred.resolve(terminalResult(attempts[5], 'timed-out'))
    await flushAttempt()
    now = 140
    attempts[6].deferred.resolve(completeResult(attempts[6]))

    await expect(leases[5].result).resolves.toMatchObject({
      status: 'complete',
      metrics: {
        queueWaitDurationsMs: [25, 0],
        providerExecutionDurationsMs: [75, 40],
        timeoutRetryCount: 1,
        cancelDebtCount: 1,
        overlappingJoinCount: 1,
        peakLocallyUnsettled: 5
      }
    })
    scheduler.stop()
  })
})
