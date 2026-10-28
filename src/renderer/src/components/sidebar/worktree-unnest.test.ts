import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { unnestWorktrees } from './worktree-unnest'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

describe('unnestWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('toasts instead of rejecting when the lineage update fails', async () => {
    const updateWorktreeLineage = vi
      .fn()
      .mockRejectedValue(new Error('Workspace identity is ambiguous across hosts'))

    await expect(unnestWorktrees(['repo1::/a'], updateWorktreeLineage)).resolves.toBeUndefined()

    expect(toast.error).toHaveBeenCalledWith('Failed to unnest workspace')
  })

  it('toasts once when several worktrees fail together', async () => {
    const updateWorktreeLineage = vi.fn().mockRejectedValue(new Error('unresolvable owner'))

    await unnestWorktrees(['repo1::/a', 'repo1::/b'], updateWorktreeLineage)

    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
