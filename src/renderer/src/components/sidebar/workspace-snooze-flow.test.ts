import { beforeEach, describe, expect, it, vi } from 'vitest'

const { updateWorktreeMeta, runSleepWorktrees, toastError } = vi.hoisted(() => ({
  updateWorktreeMeta: vi.fn(),
  runSleepWorktrees: vi.fn(async () => {}),
  toastError: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ updateWorktreeMeta }) } }))
vi.mock('./sleep-worktree-flow', () => ({ runSleepWorktrees }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { snoozeWorkspaces, wakeSnoozedWorkspaces } from './workspace-snooze-flow'

describe('workspace snooze flow', () => {
  beforeEach(() => {
    updateWorktreeMeta.mockReset()
    runSleepWorktrees.mockClear()
    toastError.mockClear()
  })

  it('persists the snooze on the owning host, then sleeps only the rows that saved', async () => {
    updateWorktreeMeta.mockImplementation(async (id: string) =>
      id === 'broken' ? { ok: false, error: 'host unreachable' } : { ok: true }
    )

    await snoozeWorkspaces(
      [
        { id: 'saved', hostId: 'ssh:box' },
        { id: 'broken', hostId: undefined }
      ],
      5_000
    )

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'saved',
      { snooze: { snoozedAt: expect.any(Number), wakeAt: 5_000 } },
      { executionHostId: 'ssh:box' }
    )
    expect(updateWorktreeMeta).toHaveBeenCalledWith('broken', expect.anything(), {
      executionHostId: 'local'
    })
    expect(runSleepWorktrees).toHaveBeenCalledWith(['saved'])
    expect(toastError).toHaveBeenCalledWith(expect.any(String), {
      description: 'host unreachable'
    })
  })

  it('wakes by clearing the snooze with null', async () => {
    updateWorktreeMeta.mockResolvedValue({ ok: true })

    await wakeSnoozedWorkspaces([{ id: 'snoozed', hostId: 'local' }])

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'snoozed',
      { snooze: null },
      { executionHostId: 'local' }
    )
    expect(toastError).not.toHaveBeenCalled()
  })
})
