import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const archiveCloudWorkspace = vi.hoisted(() => vi.fn())
const runSleepWorktree = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: toastError, dismiss: vi.fn(), success: vi.fn() })
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-actions', () => ({
  archiveCloudWorkspace,
  restartCloudWorkspace: vi.fn(),
  unarchiveCloudWorkspace: vi.fn()
}))
vi.mock('@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow', () => ({
  runSleepWorktree
}))
vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))
vi.mock('@/components/billing/plans/plans-page-store', () => ({ openPlansPage: vi.fn() }))

import { runArchiveCloudWorkspace } from './cloud-workspace-actions'
import {
  noteCloudWorkspaceDeleteSettled,
  noteCloudWorkspaceDeleting
} from '@/lib/orca-cloud/pending-cloud-archive'

describe('archive after Move to this computer vs Delete', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    noteCloudWorkspaceDeleteSettled('ws-1')
    vi.useRealTimers()
  })

  it('a Delete during the undo window cancels the queued archive', async () => {
    const done = runArchiveCloudWorkspace('ws-1', { undoMs: 5_000 })
    noteCloudWorkspaceDeleting('ws-1')
    await vi.advanceTimersByTimeAsync(6_000)
    await done
    expect(archiveCloudWorkspace).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('an archive already running stays quiet when Delete destroys the sandbox under it', async () => {
    archiveCloudWorkspace.mockImplementation(
      async (_id: string, deps: { sleep: (id: string) => Promise<unknown> }) => {
        noteCloudWorkspaceDeleting('ws-1')
        await deps.sleep('ws-1')
        return { ok: false, code: 'conflict', message: 'sandbox_destroying' }
      }
    )
    const done = runArchiveCloudWorkspace('ws-1', { undoMs: 5_000 })
    await vi.advanceTimersByTimeAsync(6_000)
    await done
    expect(runSleepWorktree).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })
})
