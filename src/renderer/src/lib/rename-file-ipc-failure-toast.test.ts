import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Why a per-site test and not only the stripper's own unit test: the shared reader is the same
 * for all 30 sites, but "the toast shows what the reader returned" is a claim about this file.
 * This is the worked example for the toast sites; the rest are covered by the shared test.
 */
const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  move: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/execute-open-editor-path-move', () => ({
  executeOpenEditorPathMove: mocks.move
}))
vi.mock('@/components/right-sidebar/fileExplorerUndoRedo', () => ({
  commitFileExplorerOp: vi.fn()
}))
vi.mock('@/components/right-sidebar/file-explorer-operation-owner', () => ({
  captureFileExplorerOperationGuard: () => ({
    assertCurrent: () => {},
    route: {
      settings: {},
      connectionId: null,
      expectedExecutionHostId: 'local',
      expectedSshTargetId: null,
      expectedSshConnectionGeneration: null
    }
  }),
  getFileExplorerOperationOwner: () => undefined
}))

const ARGS = {
  oldPath: '/repo/src/old.ts',
  newName: 'new.ts',
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

describe('renameFileOnDisk IPC failure toast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Why: this is the shape the old reader had no pattern for at all — it handed the wrapper,
  // channel name included, straight to the toast.
  it('shows the reason from a handler-for envelope', async () => {
    mocks.move.mockRejectedValue(
      new Error("Error occurred in handler for 'fs:rename': Error: EPERM: operation not permitted")
    )
    const { renameFileOnDisk } = await import('./rename-file')

    await renameFileOnDisk(ARGS)

    expect(mocks.toastError).toHaveBeenCalledWith('EPERM: operation not permitted')
  })

  it("shows the caller's own copy when the envelope carried no reason", async () => {
    mocks.move.mockRejectedValue(new Error("Error invoking remote method 'fs:rename': Error"))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { renameFileOnDisk } = await import('./rename-file')

    await renameFileOnDisk(ARGS)

    expect(mocks.toastError).toHaveBeenCalledWith("Failed to rename 'old.ts'.")
    // Why: the rejection itself must stay reachable — the sentence above replaces it on screen only.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
