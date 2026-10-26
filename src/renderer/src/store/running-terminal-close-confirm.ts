import { create } from 'zustand'
import type { CloseTerminalDialogCopyKind } from '@/components/terminal-pane/CloseTerminalDialog'

/** A pending confirmation for closing a terminal tab whose shell still has a
 *  running child process. `onConfirm` performs the original close. */
export type RunningTerminalCloseConfirmRequest = {
  terminalTabId: string
  tabLabel: string
  copyKind: CloseTerminalDialogCopyKind
  onConfirm: () => void
  onCancel?: () => void
}

export type RunningTerminalCloseConfirmState = {
  runningTerminalCloseConfirm: RunningTerminalCloseConfirmRequest | null
  requestRunningTerminalCloseConfirm: (request: RunningTerminalCloseConfirmRequest) => void
  confirmRunningTerminalClose: () => void
  /** Opting out accepts visible and queued requests; no disabled confirmation may remain waiting. */
  confirmAllRunningTerminalCloses: () => void
  dismissRunningTerminalClose: () => void
}

/** Merge duplicate tab requests so both initiating surfaces receive callbacks. */
function mergeRequests(
  pending: RunningTerminalCloseConfirmRequest,
  duplicate: RunningTerminalCloseConfirmRequest
): RunningTerminalCloseConfirmRequest {
  return {
    ...pending,
    onConfirm: () => {
      pending.onConfirm()
      duplicate.onConfirm()
    },
    onCancel: () => {
      pending.onCancel?.()
      duplicate.onCancel?.()
    }
  }
}

// Keep dialog-only state outside AppState: closeTerminalTab fixtures use partial stores and cannot safely dispatch through the app singleton.
export const useRunningTerminalCloseConfirmStore = create<RunningTerminalCloseConfirmState>()((
  set,
  get
) => {
  const queuedRequests: RunningTerminalCloseConfirmRequest[] = []
  // Guard dialog replacement against held Enter/double-click closing an unseen second tab, like pin confirmation.
  const INTER_REQUEST_ACTION_GUARD_MS = 350
  let nextRequestActionAllowedAt = 0

  /** Reveals the next queued request, and reports whether one took the visible slot. */
  const advanceRequest = (): boolean => {
    const next = queuedRequests.shift() ?? null
    set({ runningTerminalCloseConfirm: next })
    return next !== null
  }

  const guardNextAction = (revealedNextRequest: boolean): void => {
    if (revealedNextRequest) {
      nextRequestActionAllowedAt = Date.now() + INTER_REQUEST_ACTION_GUARD_MS
    }
  }

  return {
    runningTerminalCloseConfirm: null,

    requestRunningTerminalCloseConfirm: (request) => {
      const visible = get().runningTerminalCloseConfirm
      // Async process probes allow duplicate clicks before opening; share one prompt while resolving both closes.
      if (visible?.terminalTabId === request.terminalTabId) {
        set({ runningTerminalCloseConfirm: mergeRequests(visible, request) })
        return
      }
      const queuedIndex = queuedRequests.findIndex(
        (queued) => queued.terminalTabId === request.terminalTabId
      )
      if (queuedIndex !== -1) {
        queuedRequests[queuedIndex] = mergeRequests(queuedRequests[queuedIndex]!, request)
        return
      }
      if (visible) {
        // Queue rapid busy-tab closes or replacing the request strands its callback.
        queuedRequests.push(request)
        return
      }
      set({ runningTerminalCloseConfirm: request })
    },

    confirmRunningTerminalClose: () => {
      const request = get().runningTerminalCloseConfirm
      if (!request || Date.now() < nextRequestActionAllowedAt) {
        return
      }
      // Advance before onConfirm so reentrant closes cannot see the stale request.
      guardNextAction(advanceRequest())
      request.onConfirm()
    },

    confirmAllRunningTerminalCloses: () => {
      if (Date.now() < nextRequestActionAllowedAt) {
        return
      }
      const pending = [get().runningTerminalCloseConfirm, ...queuedRequests.splice(0)]
      set({ runningTerminalCloseConfirm: null })
      // No guard to arm: the queue is empty, so there is no next prompt to mis-click.
      for (const request of pending) {
        request?.onConfirm()
      }
    },

    dismissRunningTerminalClose: () => {
      const request = get().runningTerminalCloseConfirm
      if (!request || Date.now() < nextRequestActionAllowedAt) {
        return
      }
      guardNextAction(advanceRequest())
      // Why: callers such as the tab-group model resume their own cleanup on cancel.
      request.onCancel?.()
    }
  }
})
