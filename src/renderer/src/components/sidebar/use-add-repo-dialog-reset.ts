import { useCallback } from 'react'
import type { AddRepoDialogStep } from './add-repo-dialog-types'

// Why: extracted from AddRepoDialog so the dialog's own body stays under the
// max-lines ratchet — this is generic reset plumbing, not flow-specific logic.
export function useAddRepoDialogReset({
  setStep,
  setIsAdding,
  setAddProjectBusyLabel,
  resetLocalFolderFlow,
  resetServerPathFlow,
  resetCloneFlow,
  resetNestedImportFlow,
  resetNestedRepoReviewState,
  resetCreateDefaultState,
  resetCreateState,
  resetRemoteState,
  resetWslFlow
}: {
  setStep: (step: AddRepoDialogStep) => void
  setIsAdding: (isAdding: boolean) => void
  setAddProjectBusyLabel: (label: string | null) => void
  resetLocalFolderFlow: () => void
  resetServerPathFlow: () => void
  resetCloneFlow: () => void
  resetNestedImportFlow: () => void
  resetNestedRepoReviewState: () => void
  resetCreateDefaultState: () => void
  resetCreateState: () => void
  resetRemoteState: () => void
  resetWslFlow: () => void
}): {
  resetState: () => void
  resetHostScopedState: () => void
} {
  const resetState = useCallback(() => {
    // Why: kill the git clone process if one is running, so backing out
    // or closing the dialog doesn't leave a clone running on disk.
    void window.api.repos.cloneAbort()
    resetLocalFolderFlow()
    setStep('add')
    setIsAdding(false)
    setAddProjectBusyLabel(null)
    resetServerPathFlow()
    resetCloneFlow()
    resetNestedImportFlow()
    resetNestedRepoReviewState()
    resetCreateDefaultState()
    resetCreateState()
    resetRemoteState()
    resetWslFlow()
  }, [
    resetCloneFlow,
    resetLocalFolderFlow,
    resetNestedRepoReviewState,
    resetCreateDefaultState,
    resetServerPathFlow,
    resetNestedImportFlow,
    resetRemoteState,
    resetCreateState,
    resetWslFlow,
    setAddProjectBusyLabel,
    setIsAdding,
    setStep
  ])

  const resetHostScopedState = useCallback(() => {
    setIsAdding(false)
    setAddProjectBusyLabel(null)
    resetServerPathFlow()
    resetCloneFlow()
    resetCreateDefaultState()
    resetCreateState()
    resetRemoteState()
    resetWslFlow()
  }, [
    resetCloneFlow,
    resetCreateDefaultState,
    resetCreateState,
    resetRemoteState,
    resetServerPathFlow,
    resetWslFlow,
    setAddProjectBusyLabel,
    setIsAdding
  ])

  return { resetState, resetHostScopedState }
}
