/**
 * STA-4895: the dialog's Force Delete button is a second, independent route to a delete-failure
 * toast. It ran the retry "directly rather than through the shared toast wrapper", so the main
 * process's English held-directory hint reached the user verbatim on exactly the failure it was
 * written for. Both of its outcomes have to enter the same copy funnel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import { WORKSPACE_DIRECTORY_HELD_HINT } from '../../../../shared/worktree/removal'
import type { Worktree } from '../../../../shared/worktree/types'

const toastError = vi.fn()

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
vi.mock('./active-worktree-focus-after-delete', () => ({
  prepareActiveWorktreeFocusAfterDelete: () => vi.fn()
}))
vi.mock('./stale-workspace-list-toast', () => ({ showWorkspaceListChangedToast: vi.fn() }))

const { runDialogForceDelete } = await import('./delete-worktree-dialog-force-delete')

const WORKTREE = {
  id: 'repo-1::C:/ws/feature',
  displayName: 'feature',
  path: 'C:/ws/feature',
  hostId: undefined
} as unknown as Worktree

const HELD_ERROR = `Failed to force delete worktree at C:\\ws\\feature. EBUSY: resource busy or locked, rmdir 'C:\\ws\\feature' ${WORKSPACE_DIRECTORY_HELD_HINT}`

function runWith(removeWorktree: () => Promise<unknown>): void {
  runDialogForceDelete({
    worktreeId: WORKTREE.id,
    currentWorktrees: [WORKTREE],
    removeWorktree: removeWorktree as never,
    closeModal: vi.fn(),
    onDeleted: vi.fn()
  })
}

function lastDescription(): string | undefined {
  return (toastError.mock.calls.at(-1)?.[1] as { description?: string } | undefined)?.description
}

describe('dialog Force Delete enters the delete copy funnel', () => {
  beforeEach(() => {
    toastError.mockClear()
  })

  it('funnels a resolved held-directory failure instead of rendering the wire anchor', async () => {
    runWith(() => Promise.resolve({ ok: false, error: HELD_ERROR }))
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())

    expect(lastDescription()).toBe(
      translate('auto.components.sidebar.delete.worktree.toast.workspaceDirectoryHeld', 'MISSING')
    )
    expect(lastDescription()).not.toContain('EBUSY')
    expect(lastDescription()).not.toContain('C:\\ws\\feature')
  })

  it('funnels a rejected force delete instead of rendering the wire anchor', async () => {
    runWith(() => Promise.reject(new Error(HELD_ERROR)))
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())

    expect(lastDescription()).toBe(
      translate('auto.components.sidebar.delete.worktree.toast.workspaceDirectoryHeld', 'MISSING')
    )
    expect(lastDescription()).not.toContain('EBUSY')
  })

  it('still shows the raw failure for errors with no dedicated copy', async () => {
    runWith(() => Promise.resolve({ ok: false, error: 'fatal: some other git failure' }))
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())

    expect(lastDescription()).toBe('fatal: some other git failure')
  })
})
