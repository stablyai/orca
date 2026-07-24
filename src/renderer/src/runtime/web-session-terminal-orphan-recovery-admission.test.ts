import { describe, expect, it } from 'vitest'
import { WebSessionTerminalOrphanRecoveryAdmission } from './web-session-terminal-orphan-recovery-admission'

function deferred<T>() {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((nextResolve) => {
      resolve = nextResolve
    }),
    resolve
  }
}

const LIMITS = {
  maxActive: 2,
  maxOwners: 3,
  maxOwnerKeyBytes: 8,
  maxTotalKeyBytes: 8,
  maxRetainedBytes: 10
}

describe('web session terminal orphan recovery admission', () => {
  it('bounds global concurrency and releases retained bytes after completion', async () => {
    const admission = new WebSessionTerminalOrphanRecoveryAdmission<number>(LIMITS)
    const releases = [deferred<number>(), deferred<number>(), deferred<number>()]
    const results = releases.map((release, index) =>
      admission.schedule(String(index), 2, () => release.promise)
    )

    expect(admission.evidence()).toMatchObject({
      active: 2,
      owners: 3,
      queued: 1,
      retainedBytes: 6
    })
    releases[0].resolve(10)
    await expect(results[0]).resolves.toBe(10)
    expect(admission.evidence()).toMatchObject({ active: 2, owners: 2, queued: 0 })
    releases[1].resolve(11)
    releases[2].resolve(12)
    await expect(Promise.all(results)).resolves.toEqual([10, 11, 12])
    expect(admission.evidence()).toEqual({
      active: 0,
      owners: 0,
      queued: 0,
      retainedBytes: 0,
      retainedKeyBytes: 0
    })
  })

  it('coalesces a stalled owner to its latest pending snapshot', async () => {
    const admission = new WebSessionTerminalOrphanRecoveryAdmission<number>(LIMITS)
    const active = deferred<number>()
    const first = admission.schedule('owner', 2, () => active.promise)
    const superseded = admission.schedule('owner', 3, async () => 2)
    const latest = admission.schedule('owner', 4, async () => 3)

    await expect(superseded).resolves.toBeNull()
    expect(admission.evidence()).toMatchObject({ active: 1, owners: 1, retainedBytes: 6 })
    active.resolve(1)
    await expect(first).resolves.toBe(1)
    await expect(latest).resolves.toBe(3)
    expect(admission.evidence().retainedBytes).toBe(0)
  })

  it('rejects owner, key, and aggregate payload overflow without running work', async () => {
    const admission = new WebSessionTerminalOrphanRecoveryAdmission<number>(LIMITS)
    const active = deferred<number>()
    const first = admission.schedule('a', 6, () => active.promise)

    await expect(admission.schedule('oversized', 1, async () => 2)).resolves.toBeNull()
    await expect(admission.schedule('b', 5, async () => 2)).resolves.toBeNull()
    active.resolve(1)
    await expect(first).resolves.toBe(1)
  })
})
