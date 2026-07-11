import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { useAddRepoDialogReset } from './use-add-repo-dialog-reset'

const mocks = vi.hoisted(() => ({
  cloneAbort: vi.fn(),
  setStep: vi.fn(),
  setIsAdding: vi.fn(),
  setAddProjectBusyLabel: vi.fn(),
  resetLocalFolderFlow: vi.fn(),
  resetServerPathFlow: vi.fn(),
  resetCloneFlow: vi.fn(),
  resetNestedImportFlow: vi.fn(),
  resetNestedRepoReviewState: vi.fn(),
  resetCreateDefaultState: vi.fn(),
  resetCreateState: vi.fn(),
  resetRemoteState: vi.fn(),
  resetWslFlow: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn
  }
})

function makeArgs(): Parameters<typeof useAddRepoDialogReset>[0] {
  return {
    setStep: mocks.setStep,
    setIsAdding: mocks.setIsAdding,
    setAddProjectBusyLabel: mocks.setAddProjectBusyLabel,
    resetLocalFolderFlow: mocks.resetLocalFolderFlow,
    resetServerPathFlow: mocks.resetServerPathFlow,
    resetCloneFlow: mocks.resetCloneFlow,
    resetNestedImportFlow: mocks.resetNestedImportFlow,
    resetNestedRepoReviewState: mocks.resetNestedRepoReviewState,
    resetCreateDefaultState: mocks.resetCreateDefaultState,
    resetCreateState: mocks.resetCreateState,
    resetRemoteState: mocks.resetRemoteState,
    resetWslFlow: mocks.resetWslFlow
  }
}

describe('useAddRepoDialogReset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { repos: { cloneAbort: mocks.cloneAbort } } })
  })

  it('resetState aborts the clone, returns to the add step, and resets every flow including wsl', async () => {
    const { useAddRepoDialogReset } = await import('./use-add-repo-dialog-reset')

    useAddRepoDialogReset(makeArgs()).resetState()

    expect(mocks.cloneAbort).toHaveBeenCalled()
    expect(mocks.setStep).toHaveBeenCalledWith('add')
    expect(mocks.resetLocalFolderFlow).toHaveBeenCalled()
    expect(mocks.resetNestedImportFlow).toHaveBeenCalled()
    expect(mocks.resetNestedRepoReviewState).toHaveBeenCalled()
    expect(mocks.resetWslFlow).toHaveBeenCalled()
  })

  it('resetHostScopedState resets only host-scoped flows, not the local/nested/step state', async () => {
    const { useAddRepoDialogReset } = await import('./use-add-repo-dialog-reset')

    useAddRepoDialogReset(makeArgs()).resetHostScopedState()

    expect(mocks.cloneAbort).not.toHaveBeenCalled()
    expect(mocks.setStep).not.toHaveBeenCalled()
    expect(mocks.resetLocalFolderFlow).not.toHaveBeenCalled()
    expect(mocks.resetNestedImportFlow).not.toHaveBeenCalled()
    expect(mocks.resetNestedRepoReviewState).not.toHaveBeenCalled()
    expect(mocks.resetServerPathFlow).toHaveBeenCalled()
    expect(mocks.resetCloneFlow).toHaveBeenCalled()
    expect(mocks.resetCreateDefaultState).toHaveBeenCalled()
    expect(mocks.resetCreateState).toHaveBeenCalled()
    expect(mocks.resetRemoteState).toHaveBeenCalled()
    expect(mocks.resetWslFlow).toHaveBeenCalled()
  })
})
