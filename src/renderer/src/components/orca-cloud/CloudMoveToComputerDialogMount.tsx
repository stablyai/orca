// App-level mount for the "Move to this computer" dialog, with conflicts read from the store.
import React from 'react'
import { useAppStore } from '@/store'
import { countWorkingAgents } from '@/lib/agent-status/aggregation/worktree-agent-status'
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
  if (!taken || shortBranch === null) {
    return { branchCheckedOutLocally: null }
  }
  // The transfer renames a taken branch with the first free numeric suffix.
  const names = new Set(all.map((worktree) => worktree.branch?.replace(/^refs\/heads\//, '')))
  let suffix = 2
  while (names.has(`${shortBranch}-${suffix}`)) {
    suffix++
  }
  return { branchCheckedOutLocally: { branch: shortBranch, newName: `${shortBranch}-${suffix}` } }
}

/** Agents working in this workspace right now (archiving afterwards would stop them). */
export function cloudMoveRunningAgentsFor(workspaceId: string): number {
  const state = useAppStore.getState()
  return countWorkingAgents({
    ...state,
    tabsByWorktree: { [workspaceId]: state.tabsByWorktree[workspaceId] ?? [] }
  })
}

export function CloudMoveToComputerDialogMount(): React.JSX.Element {
  return (
    <CloudMoveToComputerDialogHost
      conflictsFor={cloudMoveConflictsFor}
      runningAgentsFor={cloudMoveRunningAgentsFor}
    />
  )
}
