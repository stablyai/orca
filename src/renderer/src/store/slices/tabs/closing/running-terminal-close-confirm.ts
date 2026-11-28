import { create } from 'zustand'
import type { CloseTerminalDialogCopyKind } from '@/components/terminal-pane/layout/close/CloseTerminalDialog'

/** A pending confirmation for closing a terminal tab whose shell still has a
 *  running child process. `onConfirm` performs the original close. */
export type RunningTerminalCloseConfirmRequest = {
  terminalTabId: string
  copyKind: CloseTerminalDialogCopyKind
  /** The tab's workspace, named in the title. */
  worktreeId?: string
  /** Sleeping this workspace keeps the busy agents resumable, so it is offered instead. */
  canSleepInstead?: boolean
  onConfirm: () => void
  onCancel?: () => void
}

export type RunningTerminalCloseConfirmOptions = {
  /** Confirm when the same tab's prompt is already visible; leave false on async probe completions so pre-prompt double-clicks fold safely. */
  confirmDuplicate?: boolean
}

export type RunningTerminalCloseConfirmState = {
  runningTerminalCloseConfirm: RunningTerminalCloseConfirmRequest | null
  requestRunningTerminalCloseConfirm: (
    request: RunningTerminalCloseConfirmRequest,
    options?: RunningTerminalCloseConfirmOptions
  ) => void
  confirmRunningTerminalClose: () => void
  /** Opting out accepts visible and queued requests; no disabled confirmation may remain waiting. */
  confirmAllRunningTerminalCloses: () => void
  dismissRunningTerminalClose: () => boolean
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
    nextRequestActionAllowedAt = revealedNextRequest
      ? Date.now() + INTER_REQUEST_ACTION_GUARD_MS
      : 0
  }

  return {
    runningTerminalCloseConfirm: null,

    requestRunningTerminalCloseConfirm: (request, options) => {
      const visible = get().runningTerminalCloseConfirm
      if (visible?.terminalTabId === request.terminalTabId) {
        // Only an already-visible prompt opts into duplicate confirmation; async probe completions still fold safely.
        set({ runningTerminalCloseConfirm: mergeRequests(visible, request) })
        if (options?.confirmDuplicate === true) {
          get().confirmRunningTerminalClose()
        }
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
        return false
      }
      guardNextAction(advanceRequest())
      // Why: callers such as the tab-group model resume their own cleanup on cancel.
      request.onCancel?.()
      return true
    }
  }
})
