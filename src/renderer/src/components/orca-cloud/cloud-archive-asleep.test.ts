import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const archiveCloudWorkspace = vi.hoisted(() => vi.fn())
const runSleepWorktreeVerified = vi.hoisted(() => vi.fn(async () => false))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() })
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-actions', () => ({
  archiveCloudWorkspace,
  restartCloudWorkspace: vi.fn(),
  unarchiveCloudWorkspace: vi.fn()
}))
vi.mock('@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow', () => ({
  runSleepWorktreeVerified
}))
vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))

import { runArchiveCloudWorkspace } from './cloud-workspace-actions'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'

describe('archiving a workspace that is already asleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('archives without a sleep (which could only fail against its stopped VM)', async () => {
    seedCloudWorkspaceSnapshot({
      ids: new Set(['ws-asleep']),
      idsLoaded: true,
      status: {
        'ws-asleep': {
          status: {
            state: 'sleeping',
            metrics: null,
            uptimeMs: null,
            usage: { totalMs: 0, centsPerHour: 0, costCents: 0 },
            archive: null,
            checkedAt: 1
          },
          loading: false,
          error: null,
          fetchedAt: 1
        }
      }
    })
    let slept: readonly { completed: boolean }[] | void = undefined
    archiveCloudWorkspace.mockImplementation(
      async (
        _id: string,
        deps: { sleep: (id: string) => Promise<readonly { completed: boolean }[] | void> }
      ) => {
        slept = await deps.sleep('ws-asleep')
        return { ok: true, value: null }
      }
    )
    const done = runArchiveCloudWorkspace('ws-asleep', { undoMs: 5_000 })
    await vi.advanceTimersByTimeAsync(6_000)
    await done
    expect(runSleepWorktreeVerified).not.toHaveBeenCalled()
    expect(slept).toEqual([{ completed: true }])
  })
})
