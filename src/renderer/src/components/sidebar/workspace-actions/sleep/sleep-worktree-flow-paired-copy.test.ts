// SLEEP-IN-PROGRESS (2/2): Sleep on a PAIRED cloud workspace marks its read-only copy saving from the
// press (like an owned one), and clears it when the control plane left its sandbox running.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sleepPairedCloudSandboxes: vi.fn(async (_ids: readonly string[]): Promise<string[]> => [])
}))

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/orca-cloud/paired-cloud-sleep', () => ({
  sleepPairedCloudSandboxes: mocks.sleepPairedCloudSandboxes,
  isPairedCloudSleepTarget: (id: string) => id === 'repo::/workspace/orca-sandbox-paired'
}))
vi.mock('@/lib/orca-cloud/cloud-sleep-failure-toast', () => ({
  toastCloudSleepFailure: () => true
}))
vi.mock('@/lib/orca-cloud/cloud-predictive-wake', () => ({ notePredictiveWakeSlept: vi.fn() }))
vi.mock('@/lib/orca-cloud-session-toasts', () => ({ dismissOrcaCloudRestartWarning: vi.fn() }))
vi.mock('./workspace-sleep-view-hold', () => ({ holdActiveCloudSleepView: vi.fn() }))
vi.mock('./workspace-sleep-target', () => ({
  workspaceSleepTarget: (_state: unknown, worktreeId: string) => ({ worktreeId })
}))

import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  isWorktreeGoingToSleep,
  resetWorktreeSleepViewForTests,
  sleepCopySave
} from '@/lib/worktree-sleep-view'
import { PAIRED_HOST_SLEEP_TIMEOUT_MS, runSleepWorktrees } from './sleep-worktree-flow'

const T0 = 1_800_000_000_000
const PAIRED = 'repo::/workspace/orca-sandbox-paired'
const LOCAL = 'repo::/local'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  resetWorktreeSleepViewForTests()
  mocks.sleepPairedCloudSandboxes.mockReset()
  mocks.sleepPairedCloudSandboxes.mockResolvedValue([])
  seedCloudWorkspaceSnapshot({ paired: { [PAIRED]: 'env-paired' }, idsLoaded: true })
  vi.stubGlobal('window', {
    api: {
      worktrees: {
        sleep: async ({ targets }: { targets: { worktreeId: string }[] }) =>
          targets.map(({ worktreeId }) => ({ worktreeId, chatFailed: false, receipts: [] }))
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  seedCloudWorkspaceSnapshot({})
  resetWorktreeSleepViewForTests()
  vi.useRealTimers()
})

describe('runSleepWorktrees on a paired cloud workspace', () => {
  it('marks the paired copy saving from the press; a non-cloud row gets nothing', async () => {
    await runSleepWorktrees([PAIRED, LOCAL])
    expect(sleepCopySave(PAIRED)).toEqual({ state: 'saving', since: T0 })
    expect(sleepCopySave(LOCAL)).toBeNull()
  })

  it('stays going to sleep until the paired sandbox slept, so no reconnect banner shows (SLEEP-RECONNECT-BANNER)', async () => {
    let finishPairedSleep: (stillRunning: string[]) => void = () => undefined
    let goingDuringPairedSleep: { paired: boolean; local: boolean } | null = null
    mocks.sleepPairedCloudSandboxes.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          goingDuringPairedSleep = {
            paired: isWorktreeGoingToSleep(PAIRED),
            local: isWorktreeGoingToSleep(LOCAL)
          }
          finishPairedSleep = resolve
        })
    )
    const done = runSleepWorktrees([PAIRED, LOCAL])
    await vi.waitFor(() => expect(goingDuringPairedSleep).not.toBeNull())
    // The control plane is still suspending the paired sandbox: it is going to sleep, not down.
    expect(goingDuringPairedSleep).toEqual({ paired: true, local: false })
    finishPairedSleep([])
    await done
    expect(isWorktreeGoingToSleep(PAIRED)).toBe(false)
  })

  it('clears it when the control plane left the paired sandbox running', async () => {
    mocks.sleepPairedCloudSandboxes.mockResolvedValue([PAIRED])
    await runSleepWorktrees([PAIRED])
    expect(sleepCopySave(PAIRED)).toBeNull()
  })
})

describe('a paired host-side Sleep that never finishes (PAIRED-ARCHIVE-STALL, n40b)', () => {
  function hangHostSleep(): void {
    window.api.worktrees.sleep = () => new Promise<never>(() => undefined)
  }

  it('is left behind after the timeout: the control plane still sleeps the paired sandbox', async () => {
    hangHostSleep()
    const done = runSleepWorktrees([PAIRED])
    await vi.advanceTimersByTimeAsync(PAIRED_HOST_SLEEP_TIMEOUT_MS)
    const results = await done
    expect(mocks.sleepPairedCloudSandboxes).toHaveBeenCalledWith([PAIRED])
    // Nothing reported as not slept, so an Archive waiting on this Sleep goes ahead.
    expect(results.every((result) => result.completed)).toBe(true)
  })

  it('a non-paired workspace in the same batch reports the timeout as a failure', async () => {
    hangHostSleep()
    const done = runSleepWorktrees([PAIRED, LOCAL])
    await vi.advanceTimersByTimeAsync(PAIRED_HOST_SLEEP_TIMEOUT_MS)
    await done
    // The local row was not slept: it is not handed to the paired sleep.
    expect(mocks.sleepPairedCloudSandboxes).toHaveBeenCalledWith([PAIRED])
  })

  it('without a paired target nothing is bounded: an owned or local Sleep waits as before', async () => {
    let finished = false
    hangHostSleep()
    void runSleepWorktrees([LOCAL]).then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(PAIRED_HOST_SLEEP_TIMEOUT_MS * 2)
    expect(finished).toBe(false)
  })
})
