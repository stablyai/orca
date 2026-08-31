/**
 * STA-4895: every non-interactive delete error must enter the shared copy funnel. The held-
 * workspace-directory hint is English text the main process appends as a wire anchor, so either
 * a resolved failure or a rejected promise that bypasses the funnel puts it in front of the user.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_DIRECTORY_HELD_HINT } from '../../../../shared/worktree/removal'
import { translate } from '@/i18n/i18n'

const toastError = vi.fn()
const removeWorktree = vi.fn()

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('./active-worktree-focus-after-delete', () => ({
  prepareActiveWorktreeFocusAfterDelete: () => vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      removeWorktree,
      deleteStateByWorktreeId: {
        'repo-1::/ws/feature': { canForceDelete: true, forceDeleteReason: 'dirty' }
      },
      gitStatusByWorktree: {},
      setRightSidebarTab: vi.fn(),
      setRightSidebarOpen: vi.fn()
    })
  }
}))

const capturedForceHandlers: (() => void)[] = []
vi.mock('./delete-worktree-failure-toast', () => ({
  showDeleteWorktreeFailureToast: (options: { onForceDelete: () => void }) => {
    capturedForceHandlers.push(options.onForceDelete)
  }
}))

const { runWorktreeDeleteWithToast } = await import('./run-worktree-delete-with-toast')

const HELD_ERROR = `Failed to force delete worktree at C:\\ws\\feature. EBUSY: resource busy or locked, rmdir 'C:\\ws\\feature' ${WORKSPACE_DIRECTORY_HELD_HINT}`

describe('runWorktreeDeleteWithToast force-delete retry', () => {
  beforeEach(() => {
    toastError.mockClear()
    removeWorktree.mockReset()
    capturedForceHandlers.length = 0
  })

  it('does not put the main process hint in front of the user when the retry fails', async () => {
    removeWorktree.mockResolvedValueOnce({ ok: false, error: 'dirty' })
    await runWorktreeDeleteWithToast(
      { id: 'repo-1::/ws/feature', executionHostId: null },
      'feature'
    )

    removeWorktree.mockResolvedValueOnce({ ok: false, error: HELD_ERROR })
    capturedForceHandlers[0]?.()
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())

    // The initial `dirty` failure renders through showDeleteWorktreeFailureToast, mocked above,
    // so every sonner call here is the retry's — pinned rather than assumed.
    expect(toastError).toHaveBeenCalledTimes(1)
    const description = (toastError.mock.calls.at(-1)?.[1] as { description?: string })?.description
    expect(description).toBe(
      translate('auto.components.sidebar.delete.worktree.toast.workspaceDirectoryHeld', 'MISSING')
    )
    expect(description).not.toContain('EBUSY')
  })

  it('funnels a rejected force-delete retry before rendering its error', async () => {
    removeWorktree.mockResolvedValueOnce({ ok: false, error: 'dirty' })
    await runWorktreeDeleteWithToast(
      { id: 'repo-1::/ws/feature', executionHostId: null },
      'feature'
    )

    removeWorktree.mockRejectedValueOnce(new Error(HELD_ERROR))
    capturedForceHandlers[0]?.()
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())

    expect(toastError).toHaveBeenCalledTimes(1)
    const description = (toastError.mock.calls.at(-1)?.[1] as { description?: string })?.description
    expect(description).toBe(
      translate('auto.components.sidebar.delete.worktree.toast.workspaceDirectoryHeld', 'MISSING')
    )
    expect(description).not.toContain('EBUSY')
    // A rejected Force Delete is still a force delete, not an ordinary one.
    expect(toastError.mock.calls.at(-1)?.[0]).toBe(
      translate('auto.components.sidebar.delete.worktree.flow.4f3876c0f5', 'MISSING')
    )
  })

  it('funnels a rejected initial delete before rendering its error', async () => {
    removeWorktree.mockRejectedValueOnce(new Error(HELD_ERROR))

    await runWorktreeDeleteWithToast(
      { id: 'repo-1::/ws/feature', executionHostId: null },
      'feature'
    )

    expect(toastError).toHaveBeenCalledTimes(1)
    const description = (toastError.mock.calls.at(-1)?.[1] as { description?: string })?.description
    expect(description).toBe(
      translate('auto.components.sidebar.delete.worktree.toast.workspaceDirectoryHeld', 'MISSING')
    )
    expect(description).not.toContain('EBUSY')
  })

  it('still shows the raw failure for errors with no dedicated copy', async () => {
    removeWorktree.mockResolvedValueOnce({ ok: false, error: 'dirty' })
    await runWorktreeDeleteWithToast(
      { id: 'repo-1::/ws/feature', executionHostId: null },
      'feature'
    )

    removeWorktree.mockResolvedValueOnce({ ok: false, error: 'fatal: some other git failure' })
    capturedForceHandlers[0]?.()
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())

    expect(toastError).toHaveBeenCalledTimes(1)
    expect((toastError.mock.calls.at(-1)?.[1] as { description?: string })?.description).toBe(
      'fatal: some other git failure'
    )
  })
})
