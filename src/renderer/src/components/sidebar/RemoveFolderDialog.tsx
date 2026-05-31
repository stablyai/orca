import React, { useCallback, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '@/store'

const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeProject = useAppStore((s) => s.removeProject)

  const isOpen = activeModal === 'confirm-remove-folder'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const repoIds = useMemo(
    () =>
      Array.isArray(modalData.repoIds)
        ? modalData.repoIds.filter((id): id is string => typeof id === 'string')
        : repoId
          ? [repoId]
          : [],
    [modalData.repoIds, repoId]
  )
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : ''
  const displayNames = useMemo(
    () =>
      Array.isArray(modalData.displayNames)
        ? modalData.displayNames.filter((name): name is string => typeof name === 'string')
        : displayName
          ? [displayName]
          : [],
    [displayName, modalData.displayNames]
  )
  const onRemoved =
    typeof modalData.onRemoved === 'function'
      ? (modalData.onRemoved as (repoIds: string[]) => void)
      : null
  const isBatchRemove = repoIds.length > 1

  const handleConfirm = useCallback(() => {
    if (repoIds.length > 0) {
      void (async () => {
        for (const id of repoIds) {
          await removeProject(id)
        }
        onRemoved?.(repoIds)
      })()
    }
    closeModal()
  }, [closeModal, onRemoved, removeProject, repoIds])

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
          <DialogTitle className="text-sm">
            {isBatchRemove ? 'Remove Projects' : 'Remove Project'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isBatchRemove ? (
              <>
                This only removes{' '}
                <span className="font-medium text-foreground">{repoIds.length} projects</span> from
                Orca. Their folders and git worktrees stay on disk.
              </>
            ) : (
              <>
                This only removes{' '}
                <span className="break-all font-medium text-foreground">{displayName}</span> from
                Orca. It is still on your disk.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {isBatchRemove ? (
          <ScrollArea className="max-h-44 rounded-md border border-border/70 bg-muted/35 text-xs">
            <div className="space-y-1 px-3 py-2">
              {repoIds.map((id, index) => {
                const name = displayNames[index] ?? id
                return (
                  <div
                    key={id}
                    className="break-all border-b border-border/50 py-1 font-medium text-foreground last:border-0"
                  >
                    {name}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default RemoveFolderDialog
