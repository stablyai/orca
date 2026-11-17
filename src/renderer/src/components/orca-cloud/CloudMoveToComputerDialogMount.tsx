// App-level mount for the "Move to this computer" dialog, with conflicts read from the store.
import React from 'react'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getWorkingAgentsPerWorktree } from '@/lib/agent-status/aggregation/worktree-agent-status'
import { CloudMoveToComputerDialogHost } from './CloudMoveToComputerDialog'
import type { CloudMoveConflicts } from './CloudMoveToComputerView'

/**
 * The cloud branch is already checked out by another workspace of the same project here: the move
 * gives it a new name (the exact name is picked during the move).
 */
function cloudMoveConflictsFor(workspaceId: string): CloudMoveConflicts {
  const all = Object.values(selectWorktreesByRepo(useAppStore.getState())).flat()
  const self = all.find((worktree) => worktree.id === workspaceId)
  const shortBranch = self?.branch?.replace(/^refs\/heads\//, '') ?? null
  const taken =
    shortBranch !== null &&
    all.some(
      (worktree) =>
        worktree.id !== workspaceId &&
        worktree.repoId === self?.repoId &&
        worktree.branch?.replace(/^refs\/heads\//, '') === shortBranch
    )
  return { branchCheckedOutLocally: taken && shortBranch ? { branch: shortBranch } : null }
}

/** Agents working in this workspace right now (archiving afterwards would stop them). */
function cloudMoveRunningAgentsFor(workspaceId: string): number {
  return getWorkingAgentsPerWorktree(useAppStore.getState())[workspaceId]?.agents.length ?? 0
}

export function CloudMoveToComputerDialogMount(): React.JSX.Element {
  return (
    <CloudMoveToComputerDialogHost
      conflictsFor={cloudMoveConflictsFor}
      runningAgentsFor={cloudMoveRunningAgentsFor}
    />
  )
}
