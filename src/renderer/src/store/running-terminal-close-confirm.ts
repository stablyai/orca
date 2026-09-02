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
  /** Accepts the visible request and every queued one. Used when the user ticks "don't ask
   *  again": a prompt they just opted out of must not still be waiting behind this one. */
  confirmAllRunningTerminalCloses: () => void
  dismissRunningTerminalClose: () => void
}

/** Folds a duplicate request for the same tab into the pending one instead of dropping it,
 *  so two surfaces closing the same tab both get their callback. */
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

// Why a standalone store instead of an AppState slice (which is what the sibling
// pinned-tab confirmation uses): the request is raised from closeTerminalTab, a plain
// module whose unit fixtures build partial app-state objects, so dispatching through
// useAppStore.getState() would throw there. Nothing outside the dialog reads this state,
// so the AppState coupling would buy nothing.
export const useRunningTerminalCloseConfirmStore = create<RunningTerminalCloseConfirmState>()((
  set,
  get
) => {
  const queuedRequests: RunningTerminalCloseConfirmRequest[] = []
  // Why: a queued request replaces the visible one in place, so a double-click or held
  // Enter meant for the tab the user was looking at would land on the next tab's prompt and
  // kill a second running process unseen. Matches the sibling pinned-tab confirmation.
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
      // Why: the probe is async, so a second click on the same tab arrives before the
      // dialog opens. One prompt, but both closes still resolve.
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
        // Why: closing two busy tabs in quick succession must not strand the second
        // tab's close callback behind a replaced request.
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
      // Why: advance before running onConfirm so a re-entrant close queues behind the
      // next real request instead of seeing the stale one.
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
