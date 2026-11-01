import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { LocalBaseRefDriftWarning } from '../../../../../../shared/worktree/base-ref-drift-types'
import { showLocalBaseRefDriftWarningToast } from './local-base-ref-drift-warning-toast'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn() }
}))

const warning: LocalBaseRefDriftWarning = {
  baseRef: 'develop',
  defaultBaseRef: 'origin/main',
  ahead: 0,
  behind: 692,
  relation: 'behind'
}

const worktree = {
  id: 'repo-1::/workspace/stale',
  displayName: 'stale workspace',
  branch: 'stale-workspace',
  path: '/workspace/stale'
}

afterEach(() => vi.clearAllMocks())

describe('showLocalBaseRefDriftWarningToast', () => {
  it('shows a warning for a stale selected base', () => {
    showLocalBaseRefDriftWarningToast(warning, worktree)

    expect(toast.warning).toHaveBeenCalledWith(
      'Base ref may be stale for "stale workspace"',
      expect.objectContaining({
        description: 'Selected base develop is 692 commit(s) behind origin/main.',
        id: 'local-base-ref-drift-warning:repo-1::/workspace/stale'
      })
    )
  })

  it('does nothing when no drift was reported', () => {
    showLocalBaseRefDriftWarningToast(undefined, worktree)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
