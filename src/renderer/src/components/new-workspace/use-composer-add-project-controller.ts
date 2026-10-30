import { useCallback, useMemo, useState, type RefObject } from 'react'
import type { AddRepoDialogHostedController } from '@/components/sidebar/use-add-repo-hosted-controller'

export function useComposerAddProjectController(
  selectAddedProjectRepo: (repoId: string) => void,
  selectAddedProjectGroup: (groupId: string) => boolean,
  nameInputRef: RefObject<HTMLInputElement | null>
): {
  addProjectOpen: boolean
  addProjectMounted: boolean
  openAddProject: () => void
  addProjectController: AddRepoDialogHostedController
} {
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [addProjectMounted, setAddProjectMounted] = useState(false)
  const openAddProject = useCallback(() => {
    setAddProjectMounted(true)
    setAddProjectOpen(true)
  }, [])
  const handleAddProjectCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault()
      nameInputRef.current?.focus()
    },
    [nameInputRef]
  )
  const addProjectController = useMemo<AddRepoDialogHostedController>(
    () => ({
      open: addProjectOpen,
      onOpenChange: setAddProjectOpen,
      onProjectAdded: selectAddedProjectRepo,
      onProjectGroupImported: selectAddedProjectGroup,
      onCloseAutoFocus: handleAddProjectCloseAutoFocus
    }),
    [
      addProjectOpen,
      handleAddProjectCloseAutoFocus,
      selectAddedProjectRepo,
      selectAddedProjectGroup
    ]
  )
  return { addProjectOpen, addProjectMounted, openAddProject, addProjectController }
}
