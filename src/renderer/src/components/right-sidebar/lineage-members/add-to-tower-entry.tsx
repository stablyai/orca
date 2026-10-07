import React, { createContext, useContext, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { AddToTowerDialog, addToTowerLabel } from './AddToTowerDialog'

export type AddToTowerEntryValue = {
  parentWorkspaceKey: string
  onChanged: () => void
}

/** Provided by Checks and Source Control only on their single-panel path while lineage IPC is supported. */
export const AddToTowerEntryContext = createContext<AddToTowerEntryValue | null>(null)

export function AddToTowerContextDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element | null {
  const entry = useContext(AddToTowerEntryContext)
  if (!entry) {
    return null
  }
  return (
    <AddToTowerDialog
      open={open}
      onOpenChange={onOpenChange}
      parentWorkspaceKey={entry.parentWorkspaceKey}
      onChanged={entry.onChanged}
    />
  )
}

export function AddToTowerMenuItem({
  onOpen,
  separated = false
}: {
  onOpen: () => void
  separated?: boolean
}): React.JSX.Element | null {
  if (!useContext(AddToTowerEntryContext)) {
    return null
  }
  return (
    <>
      {separated ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={onOpen}>
        <Plus className="size-3.5" />
        {addToTowerLabel()}
      </DropdownMenuItem>
    </>
  )
}

/** Entry point for empty states, which have no header menu. */
export function AddToTowerEmptyAction(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!useContext(AddToTowerEntryContext)) {
    return null
  }
  return (
    <>
      <Button size="xs" variant="ghost" className="mt-3" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {addToTowerLabel()}
      </Button>
      <AddToTowerContextDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
