import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import type { CompleteGitRepoAdd } from './use-complete-git-repo-add'

/** Contract a host surface (e.g. the workspace composer modal) passes to
 *  AddRepoDialog to nest it as a layered dialog instead of the store modal. */
export type AddRepoDialogHostedController = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a Git project is added; the host selects the new project
   *  instead of running the default-checkout navigation handoff. */
  onProjectAdded: (repoId: string) => void | Promise<void>
  /** Called after a nested folder import created a project group, so the host
   *  can select the group the user asked for instead of one member project.
   *  Returns false when the group is not selectable, which sends the caller
   *  back to the single-project handoff. */
  onProjectGroupImported?: (projectGroupId: string) => boolean
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
  handleOpenSshSettings: () => void
} {
  const storeCloseModal = useAppStore((s) => s.closeModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
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
        ? async (repoId, _source, outcome): Promise<void> => {
            await markOnboardingProjectAdded('addedRepo')
            hostedOnOpenChange(false)
            // Why: "import as group" picked the group as the target, so select
            // it and fall back to the project only when it is not selectable.
            const groupId = outcome?.importedProjectGroupId
            if (groupId && hostedOnProjectGroupImported?.(groupId)) {
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
  const handleOpenSshSettings = useCallback((): void => {
    closeModal()
    // Why: Settings is a full page; in hosted mode the composer modal in the
    // activeModal slot would otherwise stay open on top of it.
    if (hostedOnOpenChange) {
      storeCloseModal()
    }
    openSettingsTarget({ pane: 'ssh', repoId: null, sectionId: 'ssh' })
    openSettingsPage()
  }, [closeModal, hostedOnOpenChange, openSettingsPage, openSettingsTarget, storeCloseModal])
  return { closeModal, closeForFolderHandoff, finishProjectAdd, handleOpenSshSettings }
}
