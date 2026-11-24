import { useCallback, useMemo, useState, type RefObject } from 'react'
import type { AddRepoDialogEntryRequest } from '@/components/sidebar/project-admission/dialog/add-repo-dialog-types'
import type { AddRepoDialogHostedController } from '@/components/sidebar/project-admission/host-selection/use-add-repo-hosted-controller'

/** Layer Add Project over the composer without unmounting its typed draft or clone/scan work. */
export function useComposerHostedAddProject({
  nameInputRef,
  selectAddedProjectRepo,
  selectAddedProjectGroup
}: {
  nameInputRef?: RefObject<HTMLInputElement | null>
  selectAddedProjectRepo: (repoId: string) => void
  selectAddedProjectGroup: (projectGroupId: string) => boolean | Promise<boolean>
}): {
  addProjectOpen: boolean
  addProjectMounted: boolean
  nestedDialogCount: number
  addProjectController: AddRepoDialogHostedController
  handleNestedDialogOpenChange: (nextOpen: boolean) => void
  handleOpenAddProject: () => void
  handleOpenAddProjectEntryRequest: (request: AddRepoDialogEntryRequest) => void
} {
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [addProjectMounted, setAddProjectMounted] = useState(false)
  const [addProjectEntryRequest, setAddProjectEntryRequest] =
    useState<AddRepoDialogEntryRequest | null>(null)
  const [nestedDialogCount, setNestedDialogCount] = useState(0)

  const handleNestedDialogOpenChange = useCallback((nextOpen: boolean): void => {
    setNestedDialogCount((count) => Math.max(0, count + (nextOpen ? 1 : -1)))
  }, [])

  const handleOpenAddProject = useCallback((): void => {
    setAddProjectEntryRequest(null)
    setAddProjectMounted(true)
    setAddProjectOpen(true)
  }, [])

  const handleOpenAddProjectEntryRequest = useCallback(
    (request: AddRepoDialogEntryRequest): void => {
      setAddProjectEntryRequest(request)
      setAddProjectMounted(true)
      setAddProjectOpen(true)
    },
    []
  )

  const handleProjectAdded = useCallback(
    (repoId: string): void => {
      selectAddedProjectRepo(repoId)
      // Direct local folder picks never open a dialog surface, so focus the name field explicitly too.
      requestAnimationFrame(() => nameInputRef?.current?.focus())
    },
    [nameInputRef, selectAddedProjectRepo]
  )

  const handleAddProjectCloseAutoFocus = useCallback(
    (event: Event): void => {
      // After Add Project, focus the name field; Radix's original combobox row may be unmounted.
      event.preventDefault()
      nameInputRef?.current?.focus()
    },
    [nameInputRef]
  )

  const addProjectController = useMemo<AddRepoDialogHostedController>(
    () => ({
      open: addProjectOpen,
      onOpenChange: setAddProjectOpen,
      entryRequest: addProjectEntryRequest,
      onProjectAdded: handleProjectAdded,
      onProjectGroupImported: selectAddedProjectGroup,
      onCloseAutoFocus: handleAddProjectCloseAutoFocus
    }),
    [
      addProjectEntryRequest,
      addProjectOpen,
      handleAddProjectCloseAutoFocus,
      handleProjectAdded,
      selectAddedProjectGroup
    ]
  )

  return {
    addProjectOpen,
    addProjectMounted,
    nestedDialogCount,
    addProjectController,
    handleNestedDialogOpenChange,
    handleOpenAddProject,
    handleOpenAddProjectEntryRequest
  }
}
