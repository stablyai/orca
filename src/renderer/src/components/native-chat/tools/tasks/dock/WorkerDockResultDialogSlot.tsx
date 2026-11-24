import { lazy, Suspense, useLayoutEffect, useRef } from 'react'
import type { WorkerDockResultDialogState } from './use-worker-dock-owner-actions'
import type { WorkerDockRowView } from './WorkerDockRow'
import { returnWorkerDockFocus, workerDockOpenerPane } from './worker-dock-focus-return'

const WorkerDockResultDialog = lazy(() =>
  import('./WorkerDockResultDialog').then((module) => ({
    default: module.WorkerDockResultDialog
  }))
)

/** A settled worker's result dialog, which hands focus back to the row that opened it or, once
 *  that row is gone, to the pill in the same chat pane. */
export function WorkerDockResultDialogSlot({
  dialog,
  ownerActionsAvailable,
  onClose,
  onOpen,
  onRestore
}: {
  dialog: WorkerDockResultDialogState | null
  ownerActionsAvailable: boolean
  onClose: () => void
  onOpen: (row: WorkerDockRowView) => void
  onRestore: () => void
}) {
  // Read while the opener is on screen: the dialog may outlive its row, and its state is gone by
  // the time it hands focus back.
  const saved = useRef<{ opener: HTMLElement; pane: Element | null } | null>(null)
  const opener = dialog?.opener
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
        error={dialog.error}
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
