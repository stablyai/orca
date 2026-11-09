// App-level mount for the "Move to this computer" dialog, with conflicts read from the store.
import React from 'react'
import { useAppStore } from '@/store'
import { CloudMoveToComputerDialogHost, type CloudMoveConflicts } from './CloudMoveToComputerDialog'

/** The cloud branch is already checked out by another workspace here: the move gets a new name. */
export function cloudMoveConflictsFor(workspaceId: string): CloudMoveConflicts {
  const all = Object.values(useAppStore.getState().worktreesByRepo).flat()
  const branch = all.find((worktree) => worktree.id === workspaceId)?.branch ?? null
  const shortBranch = branch?.replace(/^refs\/heads\//, '') ?? null
  const taken =
    shortBranch !== null &&
    all.some(
      (worktree) =>
        worktree.id !== workspaceId &&
        worktree.branch?.replace(/^refs\/heads\//, '') === shortBranch
    )
  return { branchCheckedOutLocally: taken ? shortBranch : null }
}

export function CloudMoveToComputerDialogMount(): React.JSX.Element {
  return <CloudMoveToComputerDialogHost conflictsFor={cloudMoveConflictsFor} />
}
