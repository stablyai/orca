import React, { useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'

const NonGitFolderDialog = React.memo(function NonGitFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const addNonGitFolder = useAppStore((s) => s.addNonGitFolder)

  const isOpen = activeModal === 'confirm-non-git-folder'
  const folderPath = typeof modalData.folderPath === 'string' ? modalData.folderPath : ''
  const connectionId = typeof modalData.connectionId === 'string' ? modalData.connectionId : ''

  const handleConfirm = useCallback(() => {
    if (connectionId && folderPath) {
      void (async () => {
        try {
          const repo = await window.api.repos.addRemote({
            connectionId,
            remotePath: folderPath,
            kind: 'folder'
          })
          const state = useAppStore.getState()
          if (!state.repos.some((r) => r.id === repo.id)) {
            useAppStore.setState({ repos: [...state.repos, repo] })
          }
          await state.fetchWorktrees(repo.id)
        } catch {
          // Best-effort — the toast from the store handles errors
        }
      })()
    } else if (folderPath) {
      void addNonGitFolder(folderPath)
    }
    closeModal()
  }, [addNonGitFolder, closeModal, folderPath, connectionId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">Open as Folder</DialogTitle>
          <DialogDescription className="text-xs">
            This folder isn&apos;t a Git repository. You&apos;ll have the editor, terminal, and
            search, but Git-based features won&apos;t be available.
          </DialogDescription>
        </DialogHeader>

        {folderPath && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all text-muted-foreground">{folderPath}</div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Open as Folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default NonGitFolderDialog
