// SLEEP-IN-PROGRESS (2/2): Sleep on a PAIRED cloud workspace marks its read-only copy saving from the
// press (like an owned one), and clears it when the control plane left its sandbox running.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sleepPairedCloudSandboxes: vi.fn(async (_ids: readonly string[]): Promise<string[]> => [])
}))

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/orca-cloud/paired-cloud-sleep', () => ({
  sleepPairedCloudSandboxes: mocks.sleepPairedCloudSandboxes
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
import { resetWorktreeSleepViewForTests, sleepCopySave } from '@/lib/worktree-sleep-view'
import { runSleepWorktrees } from './sleep-worktree-flow'

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

  it('clears it when the control plane left the paired sandbox running', async () => {
    mocks.sleepPairedCloudSandboxes.mockResolvedValue([PAIRED])
    await runSleepWorktrees([PAIRED])
    expect(sleepCopySave(PAIRED)).toBeNull()
  })
})
