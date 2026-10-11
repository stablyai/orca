import { createElement } from 'react'
import { toast } from 'sonner'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  openWorktreeScopedToast,
  type ToastId,
  type WorktreeScopedToast
} from '@/lib/worktree-scoped-toast'
import { TransferProgressPanel } from './TransferProgressPanel'
import {
  endTransferSession,
  getTransferSession,
  settleTransferSession,
  startTransferSession,
  updateTransferRow,
  type TransferDirection,
  type TransferRow
} from './transfer-session-state'

// Why: a result that never returns (stalled link, hung remote open) must not leave the row
// promising "Cancelling…" forever; past this it says the remote state is unconfirmed.
export const CANCEL_UNCONFIRMED_AFTER_MS = 15_000

export type TransferProgressPanelHandle = {
  sessionId: string
  updateRow: (transferId: string, patch: Partial<Omit<TransferRow, 'transferId'>>) => void
  /** The click only asks; the transfer's own result later decides how the row ends. */
  markCancelling: (transferId: string) => void
  /** Holds the panel long enough to show how the transfer ended, then lets it leave. */
  settle: () => void
  /** Removes the panel at once, for paths that report their outcome elsewhere. */
  close: () => void
}

/** Ties the panel to the workspace a transfer targets; without one it shows everywhere. */
export type TransferPanelScope = { worktreeId: string }

/** A toast shown everywhere, with the same surface as a workspace-scoped one. */
function openGlobalToast(show: (id: ToastId | undefined) => ToastId): WorktreeScopedToast {
  let id = show(undefined)
  let closed = false
  return {
    refresh: () => {
      if (!closed) {
        id = show(id)
      }
    },
    isShown: () => !closed,
    close: () => {
      closed = true
      toast.dismiss(id)
    }
  }
}

export function openTransferProgressPanel(
  direction: TransferDirection,
  rows: TransferRow[],
  onCancel: (transferId: string) => void,
  scope?: TransferPanelScope
): TransferProgressPanelHandle {
  const sessionId = createBrowserUuid()
  startTransferSession(sessionId, direction, rows)
  const close = (): void => {
    endTransferSession(sessionId)
    presenter.close()
  }
  // Why: createElement, not a direct call — the toast body must be its own
  // component or its hooks run outside a component boundary.
  const renderPanel = () =>
    createElement(TransferProgressPanel, {
      sessionId,
      onCancel,
      onDismiss: close,
      onLayoutChange: () => presenter.refresh()
    })
  const panelOptions = { duration: Infinity, dismissible: false, unstyled: true }
  // Why: the id key is omitted, not set to undefined. sonner spreads these
  // options over the id it just minted, so an explicit `id: undefined`
  // makes it register the toast under a different id than it returns —
  // and the next re-issue then adds a second panel instead of updating.
  const show = (id: ToastId | undefined): ToastId =>
    id === undefined
      ? toast.custom(renderPanel, panelOptions)
      : toast.custom(renderPanel, { ...panelOptions, id })
  const presenter: WorktreeScopedToast = scope
    ? openWorktreeScopedToast({
        worktreeId: scope.worktreeId,
        show,
        // Why: hiding unmounts the panel's outcome timer, so a settled transfer
        // would otherwise never end.
        onHidden: () => {
          if (getTransferSession(sessionId)?.settled) {
            close()
          }
        }
      })
    : openGlobalToast(show)
  return {
    sessionId,
    updateRow: (transferId, patch) => updateTransferRow(sessionId, transferId, patch),
    markCancelling: (transferId) => {
      updateTransferRow(sessionId, transferId, { status: 'cancelling' })
      setTimeout(() => {
        const row = getTransferSession(sessionId)?.rows.find((r) => r.transferId === transferId)
        if (row?.status === 'cancelling') {
          updateTransferRow(sessionId, transferId, { status: 'unconfirmed' })
        }
      }, CANCEL_UNCONFIRMED_AFTER_MS)
    },
    settle: () => {
      settleTransferSession(sessionId)
      // Why: no outcome replay for a panel settled while its workspace was hidden.
      if (!presenter.isShown()) {
        close()
      }
    },
    close
  }
}
