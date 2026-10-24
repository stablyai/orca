import type { CompleteGitRepoAdd } from './use-complete-git-repo-add'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'

/** Contract a host surface (e.g. the workspace composer modal) passes to
 *  AddRepoDialog to nest it as a layered dialog instead of the store modal. */
export type AddRepoDialogHostedController = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a Git project is added; the host selects the new project
   *  instead of running the default-checkout navigation handoff. */
  onProjectAdded: (repoId: string) => void | Promise<void>
  onProjectGroupImported?: (groupId: string) => boolean | Promise<boolean>
  /** Radix close-autofocus hook for the nested dialog. Lets the host redirect
   *  focus (e.g. to the composer's name field) instead of Radix restoring it
   *  to the already-unmounted combobox row that opened the dialog. */
  onCloseAutoFocus?: (event: Event) => void
}

export function useAddRepoHostedController(hosted: AddRepoDialogHostedController | undefined): {
  closeModal: () => void
  /** Close for folder/non-git outcomes, which end in folder-workspace
   *  activation (or the confirm-non-git-folder store modal) instead of a
   *  composer selection. Hosted mode must close the composer too — leaving it
   *  open would hide the navigation behind a stale project selection. */
  closeForFolderHandoff: () => void
  finishProjectAdd: CompleteGitRepoAdd | undefined
} {
  const storeCloseModal = useAppStore((s) => s.closeModal)
  const hostedOnOpenChange = hosted?.onOpenChange
  const hostedOnProjectAdded = hosted?.onProjectAdded
  const hostedOnProjectGroupImported = hosted?.onProjectGroupImported
  // Why: hosted mode (nested inside the workspace composer) must close only
  // this dialog, never the composer modal that lives in the activeModal slot.
  const closeModal = useMemo(
    () => (hostedOnOpenChange ? () => hostedOnOpenChange(false) : storeCloseModal),
    [hostedOnOpenChange, storeCloseModal]
  )
  const finishProjectAdd = useMemo<CompleteGitRepoAdd | undefined>(
    () =>
      hostedOnOpenChange && hostedOnProjectAdded
        ? async (repoId, _source, _executionHostId, outcome): Promise<void> => {
            await markOnboardingProjectAdded('addedRepo')
            hostedOnOpenChange(false)
            if (
              outcome?.importedProjectGroupId &&
              (await hostedOnProjectGroupImported?.(outcome.importedProjectGroupId))
            ) {
              return
            }
            await hostedOnProjectAdded(repoId)
          }
        : undefined,
    [hostedOnOpenChange, hostedOnProjectAdded, hostedOnProjectGroupImported]
  )
  const closeForFolderHandoff = useMemo(
    () =>
      hostedOnOpenChange
        ? () => {
            hostedOnOpenChange(false)
            storeCloseModal()
          }
        : storeCloseModal,
    [hostedOnOpenChange, storeCloseModal]
  )
  return { closeModal, closeForFolderHandoff, finishProjectAdd }
}
