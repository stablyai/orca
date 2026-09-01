import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: toastError, info: vi.fn() } }))
// Why: this pulls in the real app store; the focus commit is irrelevant to the toast copy.
vi.mock('./active-worktree-focus-after-delete', () => ({
  prepareActiveWorktreeFocusAfterDelete: () => () => {}
}))

const { runDialogForceDelete } = await import('./delete-worktree-dialog-force-delete')
import type { Worktree } from '../../../../shared/worktree/types'

const ENVELOPE_ONLY = "Error invoking remote method 'worktrees:remove': Error"
const UNREADABLE_COPY =
  'Orca could not delete this workspace, and the failure did not include a readable reason. Retry, and send app diagnostics to support if it keeps failing.'

const worktree = {
  id: 'repo1::/w/feature',
  repoId: 'repo1',
  path: '/w/feature',
  head: 'abc123',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature'
} as Worktree

function runForceDelete(
  removeWorktree: () => Promise<{ ok: false; error: string }>
): Promise<void> {
  runDialogForceDelete({
    worktreeId: worktree.id,
    currentWorktrees: [worktree],
    removeWorktree: removeWorktree as never,
    closeModal: () => {},
    onDeleted: null
  })
  return Promise.resolve().then(() => {
    // Two microtask turns: the removal promise, then the .then/.catch that toasts.
  })
}

beforeEach(() => {
  toastError.mockClear()
})

// Why: pressing Force Delete from the failure toast runs a second removal, and its own
// failure toast read `result.error` verbatim — the same Electron envelope one click later.
describe('dialog Force Delete failure copy', () => {
  it('never shows the IPC envelope when the retry resolves as failed', async () => {
    await runForceDelete(() => Promise.resolve({ ok: false as const, error: ENVELOPE_ONLY }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0][1].description).toBe(UNREADABLE_COPY)
  })

  it('never shows the IPC envelope when the retry rejects', async () => {
    await runForceDelete(() => Promise.reject(new Error(ENVELOPE_ONLY)) as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0][1].description).toBe(UNREADABLE_COPY)
  })
})
