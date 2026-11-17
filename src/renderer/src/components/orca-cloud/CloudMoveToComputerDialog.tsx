// "Move to this computer" confirm dialog: mounted once in App. Once the move starts, its progress
// and result are the progress card in the notification stack (CloudMoveProgressCard).
import React from 'react'
import { runOrcaCloudTransferToLocal } from '@/lib/orca-cloud-transfer-flow'
import { reapplyOrcaCloudTransfer } from '@/lib/orca-cloud-transfer-reapply'
import {
  closeMoveToThisComputer,
  effectiveArchiveAfter,
  setMoveArchiveAfter,
  useCloudMoveState,
  type CloudMoveState
} from '@/lib/orca-cloud/orca-cloud-move-store'
import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { runArchiveCloudWorkspace } from './cloud-workspace-actions'
import { returnFocusToWorkspace } from './cloud-focus-return'
import { CloudMoveConfirmDialog } from './CloudMoveConfirmDialog'
import type { CloudMoveConflicts } from './CloudMoveToComputerView'

/** "Apply changes again" for a failed apply or a partial result on an existing local worktree. */
export function cloudMoveReapplyFor(state: CloudMoveState): (() => void) | undefined {
  if (state.stage === 'failed' && state.retry && state.localWorktreeId) {
    const { retry, localWorktreeId } = state
    return () =>
      void reapplyOrcaCloudTransfer({
        workspaceId: state.workspaceId,
        name: state.name,
        localWorktreeId,
        prepared: retry.prepared,
        worktreePath: retry.worktreePath,
        archiveAfter: state.archiveAfter,
        onArchive: archiveCloud
      })
  }
  if (state.stage === 'done' && state.finished.leftoverPatchDir) {
    return () =>
      void reapplyOrcaCloudTransfer({
        workspaceId: state.workspaceId,
        name: state.name,
        localWorktreeId: state.localWorktreeId,
        prepared: state.prepared,
        worktreePath: state.finished.worktreePath,
        archiveAfter: state.archiveAfter,
        onArchive: archiveCloud
      })
  }
  return undefined
}

function archiveCloud(workspaceId: string, name: string): void {
  void runArchiveCloudWorkspace(workspaceId, { name })
}

/** The dialog unmounts once the move starts; give focus back to the workspace, not <body>. */
function returnFocusAfterConfirm(): void {
  requestAnimationFrame(() =>
    returnFocusToWorkspace(useAppStore.getState().activeTabId, (tabId) =>
      focusTerminalTabSurface(tabId, null, { onlyIfFocusUnclaimed: true })
    )
  )
}

/** Starts the move (or Retry from the progress card). */
export function startCloudMove(
  state: Exclude<CloudMoveState, { stage: 'closed' }>,
  runningAgents: number
): void {
  void runOrcaCloudTransferToLocal(state.workspaceId, state.name, {
    archiveAfter:
      state.stage === 'confirm'
        ? state.archived === true || effectiveArchiveAfter(state.archiveAfter, runningAgents)
        : state.stage === 'running' || state.stage === 'failed'
          ? state.archiveAfter
          : false,
    onArchive: archiveCloud
  })
}

/** Mounted once in App; renders whatever move is open. */
export function CloudMoveToComputerDialogHost({
  conflictsFor,
  runningAgentsFor
}: {
  conflictsFor: (workspaceId: string) => CloudMoveConflicts
  runningAgentsFor: (workspaceId: string) => number
}): React.JSX.Element | null {
  const state = useCloudMoveState()
  // Only the confirm step is a dialog: the running move and its result are the progress card.
  if (state.stage !== 'confirm') {
    return null
  }
  const runningAgents = runningAgentsFor(state.workspaceId)
  return (
    <CloudMoveConfirmDialog
      state={state}
      conflicts={conflictsFor(state.workspaceId)}
      runningAgents={runningAgents}
      onConfirm={() => {
        startCloudMove(state, runningAgents)
        returnFocusAfterConfirm()
      }}
      onClose={closeMoveToThisComputer}
      onArchiveAfterChange={setMoveArchiveAfter}
    />
  )
}
