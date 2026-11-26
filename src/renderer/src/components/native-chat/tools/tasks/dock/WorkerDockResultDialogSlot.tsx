import { lazy, Suspense, useLayoutEffect, useRef } from 'react'
import type { WorkerDockResultDialogState } from './use-worker-dock-owner-actions'
import type { WorkerDockRowView } from './WorkerDockRow'
import { returnWorkerDockFocus, workerDockOpenerPane } from './worker-dock-focus-return'
import { useAppStore } from '@/store/index'
import { worktreeCatalogConfirmsAbsence } from '@/store/slices/worktrees/listing/worktree-catalog-absence'
import { parseWorkspaceKey } from '../../../../../../../shared/workspace/identity/workspace-scope'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host/execution-host'

const WorkerDockResultDialog = lazy(() =>
  import('./WorkerDockResultDialog').then((module) => ({
    default: module.WorkerDockResultDialog
  }))
)

/** A settled worker's result dialog, which hands focus back to the row that opened it or, once
 *  that row is gone, to the pill in the same chat pane. */
export function WorkerDockResultDialogSlot({
  dialog,
  hostId,
  ownerActionsAvailable,
  onClose,
  onOpen,
  onRestore
}: {
  dialog: WorkerDockResultDialogState | null
  /** The host the dock reads, whose worktree catalog says whether the worker's worktree is gone. */
  hostId: ExecutionHostId
  ownerActionsAvailable: boolean
  onClose: () => void
  onOpen: (row: WorkerDockRowView) => void
  onRestore: () => void
}) {
  // Read while the opener is on screen: the dialog may outlive its row, and its state is gone by
  // the time it hands focus back.
  const saved = useRef<{ opener: HTMLElement; pane: Element | null } | null>(null)
  const opener = dialog?.opener
  // Only a worktree this dock's host owns: its repo still names the host after the worktree is gone,
  // while a removed folder workspace or a paired host's worker leaves no proof of where it lived.
  const workspaceId = dialog?.result?.ownerActionsAvailable ? dialog.result.workspaceId : undefined
  const scope = workspaceId ? parseWorkspaceKey(workspaceId) : null
  const worktreeId = scope?.type === 'folder' ? null : (scope?.worktreeId ?? workspaceId)
  const workspaceRemoved = useAppStore((state) =>
    Boolean(worktreeId && worktreeCatalogConfirmsAbsence(state, worktreeId, hostId))
  )
  useLayoutEffect(() => {
    if (opener) {
      saved.current = { opener, pane: workerDockOpenerPane(opener) }
    }
  }, [opener])
  return dialog ? (
    <Suspense fallback={null}>
      <WorkerDockResultDialog
        ownerActionsAvailable={
          ownerActionsAvailable && dialog.result?.ownerActionsAvailable !== false
        }
        result={dialog.result}
        row={dialog.row}
        error={dialog.error}
        workspaceRemoved={workspaceRemoved}
        onClose={onClose}
        onOpen={() => onOpen(dialog.row)}
        onRestore={onRestore}
        onReturnFocus={() => {
          if (saved.current) {
            returnWorkerDockFocus(saved.current.opener, saved.current.pane)
          }
        }}
      />
    </Suspense>
  ) : null
}
