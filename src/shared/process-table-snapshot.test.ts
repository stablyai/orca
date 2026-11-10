import { describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { createProcessTableSnapshotReader } from './process-table-snapshot-reader'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('process-table-snapshot reader', () => {
  it('reports the age of the capture instant, not of the moment ps finished', async () => {
    let clock = 0
    const gate = deferred<string>()
    const reader = createProcessTableSnapshotReader({
      runPs: () => gate.promise,
      now: () => clock,
      ttlMs: 500
    })

    const first = reader.getSnapshot()
    // A capture that took 4s of wall clock describes the machine as it was 4s ago.
    clock = 4_000
    gate.resolve('scan-1')
    await first

    // Starting age at completion previously admitted already-stale captures to destructive consumers.
    expect((await reader.getSnapshotWithAge()).capturedAgeMs).toBe(4_000)
  })

  it('shares same-turn fresh requests but queues one scan after a pre-existing scan', async () => {
    let scans = 0
    const first = deferred<string>()
    const second = deferred<string>()
    const reader = createProcessTableSnapshotReader({
      runPs: () => {
        scans += 1
        return scans === 1 ? first.promise : second.promise
      },
      now: () => 0
    })

    const stale = reader.getSnapshot()
    const freshA = reader.getFreshSnapshot()
    const freshB = reader.getFreshSnapshot()
    expect(scans).toBe(1)
    first.resolve('stale')
    expect(await stale).toBe('stale')
    await Promise.resolve()
    expect(scans).toBe(2)
    second.resolve('fresh')
    expect(await freshA).toBe('fresh')
    expect(await freshB).toBe('fresh')
    expect(scans).toBe(2)
  })
})
