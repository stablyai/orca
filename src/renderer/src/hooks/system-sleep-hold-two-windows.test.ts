// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSystemSleepHoldReader } from '../../../main/macos-sleep-disabled-setting'
import type { SystemSleepHold } from '../../../shared/computer-awake-mode'
import { startSystemSleepHoldPoller } from './system-sleep-hold-poller'

const PROBE_MS = 100
const PMSET_YES = 'System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 1\n'
const PMSET_NO = 'System-wide power settings:\nCurrently in use:\n sleep 1\n'

let pmsetOutput = PMSET_YES
let spawns = 0

// Why: the real reader and cache run; only the pmset spawn is faked, with a delay like a slow probe.
function fakePmset(): Promise<{
  code: number
  signal: null
  stdout: string
  stderr: string
  timedOut: false
}> {
  spawns += 1
  const stdout = pmsetOutput
  return new Promise((resolve) =>
    setTimeout(
      () => resolve({ code: 0, signal: null, stdout, stderr: '', timedOut: false }),
      PROBE_MS
    )
  )
}

function window(read: () => Promise<SystemSleepHold>): {
  seen: () => SystemSleepHold['sleepDisabled'] | null
  stop: () => void
} {
  let last: SystemSleepHold | null = null
  const poller = startSystemSleepHoldPoller({ read, onHold: (hold) => (last = hold) })
  return { seen: () => last?.sleepDisabled ?? null, stop: poller.dispose }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-22T06:00:00Z'))
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  pmsetOutput = PMSET_YES
  spawns = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('two windows over the real SleepDisabled reader', () => {
  it('re-asks once after expiry when the setting changes during an in-flight pmset read', async () => {
    const reader = createSystemSleepHoldReader({ run: fakePmset, platform: 'darwin' })
    const windowA = window(() => reader.read())
    await vi.advanceTimersByTimeAsync(PROBE_MS / 2)

    pmsetOutput = PMSET_NO
    globalThis.window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(PROBE_MS)
    expect(windowA.seen()).toBe('yes')
    expect(spawns).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000 + PROBE_MS)
    expect(windowA.seen()).toBe('no')
    expect(spawns).toBe(2)

    windowA.stop()
    reader.dispose()
  })

  it('shows none in a window that mounted on a cached yes, within 5 s plus the probe time', async () => {
    const reader = createSystemSleepHoldReader({ run: fakePmset, platform: 'darwin' })
    const windowA = window(() => reader.read())
    await vi.advanceTimersByTimeAsync(PROBE_MS + 1)
    expect(windowA.seen()).toBe('yes')

    pmsetOutput = PMSET_NO
    await vi.advanceTimersByTimeAsync(900)
    const windowB = window(() => reader.read())
    await vi.advanceTimersByTimeAsync(0)
    expect(windowB.seen()).toBe('yes')
    expect(spawns).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000 - 1_000 + PROBE_MS + 100)
    expect(windowB.seen()).toBe('no')
    expect(spawns).toBe(2)

    windowA.stop()
    windowB.stop()
    reader.dispose()
  })
})
