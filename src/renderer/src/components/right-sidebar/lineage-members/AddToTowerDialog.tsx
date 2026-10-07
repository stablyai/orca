import React, { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { AddToTowerForm } from './AddToTowerForm'

export function addToTowerLabel(): string {
  return translate(
    'auto.components.rightSidebar.lineageMembers.addToTower.open',
    'Add to control tower…'
  )
}

type AddToTowerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentWorkspaceKey: string
  onChanged: () => void
}

/** invariant: the one add flow; Checks and Source Control entry points all open this dialog. */
export function AddToTowerDialog({
  open,
  onOpenChange,
  parentWorkspaceKey,
  onChanged
}: AddToTowerDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.rightSidebar.lineageMembers.addToTower.title',
              'Add to control tower'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.rightSidebar.lineageMembers.addToTower.description',
              'Pick a worktree, a branch or a pull request from any registered repository. Checks and Source Control show it for this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <AddToTowerForm
            parentWorkspaceKey={parentWorkspaceKey}
            onAdded={() => onOpenChange(false)}
            onChanged={onChanged}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Compact header button for the tower sections of both tabs. */
export function AddToTowerButton({
  parentWorkspaceKey,
  onChanged
}: {
  parentWorkspaceKey: string
  onChanged: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {addToTowerLabel()}
      </Button>
      <AddToTowerDialog
        open={open}
        onOpenChange={setOpen}
        parentWorkspaceKey={parentWorkspaceKey}
        onChanged={onChanged}
      />
    </>
  )
}
