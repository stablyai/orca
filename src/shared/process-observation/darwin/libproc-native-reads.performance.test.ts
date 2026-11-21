import { afterEach, expect, it, vi } from 'vitest'
import type { LibprocAddon, LibprocProcessRow } from './libproc-addon'
import {
  readFreshNativeTable,
  registerNativeRequest,
  resetNativeReadsForTests
} from './libproc-native-reads'

afterEach(() => {
  vi.restoreAllMocks()
  resetNativeReadsForTests()
})

/** Deadline timers (one per read wait, plus one per slot wait) for N distinct queries submitted together behind the 8-read cap, each read finishing in turn. */
async function deadlineTimersFor(callers: number): Promise<number> {
  const finish: (() => void)[] = []
  const addon: LibprocAddon = {
    readProcessTable: () =>
      new Promise<LibprocProcessRow[]>((resolve) => finish.push(() => resolve([])))
  }
  const timeouts = vi.spyOn(globalThis, 'setTimeout')
  const deadline = performance.now() + 60_000
  const reads = Array.from({ length: callers }, (_, i) =>
    readFreshNativeTable(
      addon,
      { command: false, pids: [i + 1] },
      registerNativeRequest(),
      deadline
    )
  )
  let settled = 0
  void Promise.all(reads).then(() => (settled = callers))
  while (settled < callers) {
    await new Promise((resolve) => setImmediate(resolve))
    finish.shift()?.()
  }
  const waits = timeouts.mock.calls.length
  timeouts.mockRestore()
  resetNativeReadsForTests()
  return waits
}

it('wakes one queued read per freed slot instead of every waiter', async () => {
  // Waking every waiter on each release cost ~4,400 timers at N=100 and ~490,000 at N=1,000.
  expect(await deadlineTimersFor(100)).toBeLessThanOrEqual(300)
  expect(await deadlineTimersFor(1_000)).toBeLessThanOrEqual(3_000)
})
